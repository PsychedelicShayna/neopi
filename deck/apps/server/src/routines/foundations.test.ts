import { stringifySettingsToml as stringifyToml } from "@oh-my-pi/pi-utils/settings-toml";
import { afterAll, afterEach, expect } from "bun:test";
import * as fs from "node:fs";
import type { RoutineTestFixture } from "./test-fixture.ts";
import * as path from "node:path";
import type { RoutineSpec } from "@npi-deck/protocol";
import { getDb } from "../db/index.ts";
import { listStepRuns } from "../db/routine-step-runs.ts";
import { createRoutine, createV1Routine, getRoutine, listRuns, updateV1Routine } from "../db/routines.ts";
import { RoutineTestFixtures } from "./test-fixture.ts";
import { createIsolatedTest, isIsolatedCase } from "../test-isolation.ts";
import { createShellFixture } from "./shell-fixture.ts";
import { observeProcessTree, unrelatedProcess } from "../../test-fixtures/process-fixture.ts";
import { resolveBackendSelection } from "../backend/runtime.ts";

const nativeBackend = resolveBackendSelection();
const isolatedTest = createIsolatedTest(
	import.meta.path,
	nativeBackend ? { NPI_DECK_BACKEND: nativeBackend.path } : {},
);
const fixtures = new RoutineTestFixtures();
function test(
	name: string,
	body: (fixture: RoutineTestFixture) => Promise<void>,
	timeout?: number,
	agentCommand?: (home: string) => string[],
): void {
	isolatedTest(name, () => fixtures.run(body, agentCommand), timeout);
}
function routine(spec: RoutineSpec, enabled = true) {
	return createV1Routine({ name: `test-${crypto.randomUUID()}`, spec, specToml: stringifyToml(spec), enabled });
}
function spec(steps: RoutineSpec["steps"], concurrency: RoutineSpec["concurrency"] = "skip"): RoutineSpec {
	return { name: "test", trigger: [{ manual: {} }], steps, concurrency };
}
if (isIsolatedCase(import.meta.path)) {
	afterEach(() => fixtures.join());
	// A timed-out hook continues running. The lease also guards admission if
	// another case is ever registered in this worker.
	afterAll(() => fixtures.join(), 60_000);
}

test("queue holds second invocation until first finishes, then releases the busy state", async ({ home, runner }) => {
	const marker = path.join(home, "marker");
	const release = path.join(home, "release");
	const shell = createShellFixture(home);
	const r = routine(
		spec([{ id: "wait", type: "run", cwd: shell.cwd, command: shell.command("hold", { marker, release }) }], "queue"),
	);
	const first = runner.fire(r.id);
	for (let i = 0; i < 60 && !fs.existsSync(marker); i++) await Bun.sleep(25);
	expect(fs.existsSync(marker)).toBe(true);
	const second = runner.fire(r.id);
	await Bun.sleep(80);
	expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(["start"]);
	expect(runner.workSnapshot).toHaveLength(2);
	fs.writeFileSync(release, "");
	await Promise.all([first, second]);
	expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(["start", "end", "start", "end"]);
	expect(runner.busy).toBe(false);
});

async function assertTimedTree({ home, runner }: RoutineTestFixture, budget: boolean): Promise<void> {
	const marker = path.join(home, "process-tree.json");
	const shell = createShellFixture(home);
	const s = spec([
		{
			id: "slow",
			type: "run",
			cwd: shell.cwd,
			timeout_secs: budget ? 20 : 1,
			command: shell.command("tree", { marker }),
		},
	]);
	if (budget) s.budget = { max_duration_secs: 1 };
	const r = routine(s);
	const control = unrelatedProcess();
	const start = Date.now();
	let tree: Awaited<ReturnType<typeof observeProcessTree>> | undefined;
	let observation: ReturnType<typeof setTimeout> | undefined;
	try {
		const fired = runner.fire(r.id);
		tree = await observeProcessTree(marker);
		observation = setTimeout(
			() =>
				console.log(
					JSON.stringify({
						event: "after-deadline",
						elapsed: Date.now() - start,
						states: tree!.states(),
					}),
				),
			1500,
		);
		await fired;
		const elapsed = Date.now() - start;
		const states = tree.states();
		console.log(JSON.stringify({ event: "tree-finished", budget, elapsed, states, control: control.status() }));
		expect(elapsed).toBeLessThan(4000);
		expect(states.every(process => process.status === "exited")).toBe(true);
		expect(control.status() === "running").toBe(true);
		const run = listRuns(r.id)[0]!;
		expect(run.abortReason).toBe("timeout");
		const [step] = listStepRuns(run.id);
		expect(step?.status).toBe("aborted");
		expect(step?.stdoutExcerpt).toContain("tree stdout ready");
		expect(step?.stderrExcerpt).toContain("tree stderr ready");
	} finally {
		clearTimeout(observation);
		tree?.kill();
		await control.close();
	}
}

test("deadline kills shell grandchild and records timeout", fixture => assertTimedTree(fixture, false));

test("run-duration budget preempts a longer step deadline and its child group", fixture =>
	assertTimedTree(fixture, true));

test("disabled webhook does not execute, successful webhook persists payload", async ({ home, runner }) => {
	const marker = path.join(home, "webhook");
	const shell = createShellFixture(home);
	const s = spec([
		{
			id: "write",
			type: "run",
			cwd: shell.cwd,
			command: shell.command("write", { marker, bytes: "yes", newline: true }),
		},
	]);
	const disabled = routine(s, false);
	await runner.fire(disabled.id, "webhook", { key: "forbidden" });
	expect(fs.existsSync(marker)).toBe(false);
	expect(listRuns(disabled.id)).toHaveLength(0);
	const enabled = routine(s);
	await runner.fire(enabled.id, "webhook", { key: "accepted" });
	expect(fs.readFileSync(marker, "utf8").trim()).toBe("yes");
	expect(JSON.parse(listRuns(enabled.id)[0]!.triggerPayload!)).toEqual({ key: "accepted" });
});

test("every trigger kind stores a bounded, parseable payload while its steps still see the full input", async ({
	home,
	runner,
}) => {
	const marker = path.join(home, "seen");
	const shell = createShellFixture(home);
	const r = routine(
		spec(
			[
				{
					id: "write",
					type: "run",
					cwd: shell.cwd,
					command: shell.command("write", { marker, append: true, newline: true }, "{{ trigger.tag }}"),
				},
			],
			"parallel",
		),
	);
	// The blob precedes the tag, so only the full in-memory payload still carries the tag.
	const payload = { blob: '"x"'.repeat(40_000), tag: "tail-marker" };
	for (const trigger of ["cron", "webhook", "event", "manual"] as const) await runner.fire(r.id, trigger, payload);
	expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(Array(4).fill("tail-marker"));
	const runs = listRuns(r.id);
	expect(runs.map(run => run.trigger).sort()).toEqual(["cron", "event", "manual", "webhook"]);
	for (const run of runs) {
		expect(Buffer.byteLength(run.triggerPayload!, "utf8")).toBeLessThanOrEqual(8 * 1024);
		const stored = JSON.parse(run.triggerPayload!);
		expect(stored.truncated).toBe(true);
		expect(stored.bytes).toBe(Buffer.byteLength(JSON.stringify(payload), "utf8"));
		expect(stored.preview.startsWith(`{"blob":"\\"x\\"`)).toBe(true);
	}
});

test("a large payload's credential is redacted before truncation while its step still receives it", async ({
	home,
	runner,
}) => {
	const marker = path.join(home, "credential");
	const shell = createShellFixture(home);
	const r = routine(
		spec([
			{
				id: "write",
				type: "run",
				cwd: shell.cwd,
				command: shell.command("write", { marker, newline: true }, "{{ trigger.client_secret }}"),
			},
		]),
	);
	// The credential comes first, so an unredacted preview would carry it.
	const payload = { client_secret: "cs-live-value", blob: "z".repeat(50_000) };
	await runner.fire(r.id, "manual", payload);
	expect(fs.readFileSync(marker, "utf8").trim()).toBe("cs-live-value");
	const stored = listRuns(r.id)[0]!.triggerPayload!;
	expect(stored).not.toContain("cs-live-value");
	const parsed = JSON.parse(stored);
	expect(parsed.truncated).toBe(true);
	expect(parsed.preview.startsWith(`{"client_secret":"[redacted]","blob":"zzz`)).toBe(true);
});

test("disabled routine ignores cron and event triggers but still runs manually", async ({ home, runner }) => {
	const marker = path.join(home, "disabled");
	const shell = createShellFixture(home);
	const r = routine(
		spec([
			{
				id: "write",
				type: "run",
				cwd: shell.cwd,
				command: shell.command("write", { marker, bytes: "ran", append: true, newline: true }),
			},
		]),
		false,
	);
	for (const trigger of ["cron", "event"] as const) await runner.fire(r.id, trigger, { source: "deck_inbox" });
	expect(fs.existsSync(marker)).toBe(false);
	expect(listRuns(r.id)).toHaveLength(0);
	await runner.fire(r.id, "manual", { key: "by-hand" });
	expect(fs.existsSync(marker)).toBe(true);
	expect(listRuns(r.id).map(run => run.trigger)).toEqual(["manual"]);
});

test("abort and continue run only once despite a retained retry block", async ({ home, runner }) => {
	const shell = createShellFixture(home);
	for (const mode of ["abort", "continue"] as const) {
		const attemptsFile = path.join(home, `attempts-${mode}`);
		const nextFile = path.join(home, `next-${mode}`);
		const r = routine(
			spec([
				{
					id: "fail",
					type: "run",
					cwd: shell.cwd,
					command: shell.command("write", {
						marker: attemptsFile,
						bytes: "attempted",
						append: true,
						newline: true,
						exitCode: 7,
					}),
					on_failure: mode,
					retry: { times: 3, backoff: "linear", max_delay_secs: 0 },
				},
				{
					id: "next",
					type: "run",
					cwd: shell.cwd,
					command: shell.command("write", { marker: nextFile, bytes: "reached", newline: true }),
				},
			]),
		);
		await runner.fire(r.id);
		expect(fs.readFileSync(attemptsFile, "utf8").trim().split("\n")).toEqual(["attempted"]);
		expect(fs.existsSync(nextFile)).toBe(mode === "continue");
		const run = listRuns(r.id)[0]!;
		expect(listStepRuns(run.id).map(attempt => [attempt.stepId, attempt.attempt, attempt.status])).toEqual(
			mode === "continue"
				? [
						["fail", 1, "failed"],
						["next", 1, "success"],
					]
				: [["fail", 1, "failed"]],
		);
		expect(run.abortReason).toBe(mode === "abort" ? "failure" : undefined);
	}
});

test("continue ignores retry policy and cancellation during retry backoff prevents next attempt", async ({
	home,
	runner,
}) => {
	const marker = path.join(home, "attempts");
	const shell = createShellFixture(home);
	const command = shell.command("write", { marker, bytes: "attempt", append: true, newline: true, exitCode: 7 });
	const r = routine(
		spec([
			{
				id: "fail",
				type: "run",
				cwd: shell.cwd,
				command,
				retry: { times: 3, backoff: "linear", max_delay_secs: 1 },
				on_failure: "continue",
			},
		]),
	);
	await runner.fire(r.id);
	expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
	const retry = routine(
		spec([
			{
				id: "fail",
				type: "run",
				cwd: shell.cwd,
				command,
				retry: { times: 3, backoff: "linear", max_delay_secs: 2 },
				on_failure: "retry",
			},
		]),
	);
	const running = runner.fire(retry.id);
	for (let i = 0; i < 40 && fs.readFileSync(marker, "utf8").trim().split("\n").length < 2; i++) await Bun.sleep(25);
	await runner.dispose();
	await running;
	expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(2);
	expect(listRuns(retry.id)[0]?.abortReason).toBe("cancelled");
});

test("multi-cron next run remains the earliest after a manual run", async ({ home, runner }) => {
	const shell = createShellFixture(home);
	const s = spec([{ id: "fast", type: "run", cwd: shell.cwd, command: shell.command("success") }]);
	s.trigger = [{ cron: "0 0 1 1 *" }, { cron: "* * * * *" }];
	const r = routine(s);
	runner.schedule(r);
	const before = getRoutine(r.id)?.nextRunAt;
	expect(before).toBeDefined();
	expect(new Date(before!).getTime() - Date.now()).toBeLessThan(61_000);
	await runner.fire(r.id);
	const after = getRoutine(r.id)?.nextRunAt;
	expect(after).toBeDefined();
	expect(new Date(after!).getTime() - Date.now()).toBeLessThan(61_000);
});

test("disabling a cron routine clears next run, and a manual run while disabled does not restore it", async ({
	home,
	runner,
}) => {
	const shell = createShellFixture(home);
	const s = spec([{ id: "fast", type: "run", cwd: shell.cwd, command: shell.command("success") }]);
	s.trigger = [{ cron: "* * * * *" }];
	const r = routine(s);
	runner.schedule(r);
	expect(getRoutine(r.id)?.nextRunAt).toBeDefined();
	runner.schedule(updateV1Routine(r.id, { enabled: false })!);
	expect(getRoutine(r.id)?.nextRunAt).toBeUndefined();
	await runner.fire(r.id, "manual");
	const after = getRoutine(r.id)!;
	expect(after.lastRunAt).toBeDefined();
	expect(after.nextRunAt).toBeUndefined();
});

test("legacy shell routines also queue before spawning and drain on shutdown", async ({ home, runner }) => {
	const marker = path.join(home, "legacy");
	const release = path.join(home, "release");
	const shell = createShellFixture(home);
	const r = createRoutine({
		name: "legacy",
		cron: "",
		actionKind: "bash",
		actionCwd: shell.cwd,
		actionBody: shell.command("hold", { marker, release }),
	});
	getDb().query("UPDATE routines SET concurrency = 'queue' WHERE id = ?").run(r.id);
	const first = runner.fire(r.id);
	for (let i = 0; i < 60 && !fs.existsSync(marker); i++) await Bun.sleep(25);
	expect(fs.existsSync(marker)).toBe(true);
	const second = runner.fire(r.id);
	await Bun.sleep(80);
	expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(["start"]);
	fs.writeFileSync(release, "");
	await Promise.all([first, second]);
	expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(["start", "end", "start", "end"]);
	expect(runner.busy).toBe(false);
});

test("skip leaves only the admitted run executing; parallel admits both", async ({ home, runner }) => {
	const marker = path.join(home, "modes");
	const release = path.join(home, "release");
	const shell = createShellFixture(home);
	const command = shell.command("hold", { marker, release });
	const skip = routine(spec([{ id: "hold", type: "run", cwd: shell.cwd, command }], "skip"));
	const first = runner.fire(skip.id);
	for (let i = 0; i < 60 && !fs.existsSync(marker); i++) await Bun.sleep(25);
	await runner.fire(skip.id);
	expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(["start"]);
	expect(listRuns(skip.id).some(run => run.abortReason === "concurrency_skipped")).toBe(true);
	fs.writeFileSync(release, "");
	await first;
	fs.unlinkSync(release);
	fs.writeFileSync(marker, "");
	const parallel = routine(spec([{ id: "hold", type: "run", cwd: shell.cwd, command }], "parallel"));
	const a = runner.fire(parallel.id);
	const b = runner.fire(parallel.id);
	for (let i = 0; i < 80 && fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).length < 2; i++)
		await Bun.sleep(25);
	expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(["start", "start"]);
	fs.writeFileSync(release, "");
	await Promise.all([a, b]);
	expect(runner.busy).toBe(false);
});

test("cancel-previous kills the running child before the replacement finishes", async ({ home, runner }) => {
	const marker = path.join(home, "cancel");
	const release = path.join(home, "release");
	const shell = createShellFixture(home);
	const r = routine(
		spec(
			[{ id: "hold", type: "run", cwd: shell.cwd, command: shell.command("hold", { marker, release }) }],
			"cancel-previous",
		),
	);
	const first = runner.fire(r.id);
	for (let i = 0; i < 60 && !fs.existsSync(marker); i++) await Bun.sleep(25);
	expect(fs.existsSync(marker)).toBe(true);
	fs.writeFileSync(release, "");
	const second = runner.fire(r.id);
	await Promise.all([first, second]);
	const lines = fs.readFileSync(marker, "utf8").trim().split("\n");
	expect(lines.filter(line => line === "start")).toHaveLength(2);
	expect(listRuns(r.id).some(run => run.abortReason === "cancelled")).toBe(true);
	expect(runner.busy).toBe(false);
});

test(
	"agent retry charges failed and successful attempts, and stops before the next attempt on budget excess",
	async ({ home, runner }) => {
		const backend = path.join(home, "backend");
		const cli = path.join(backend, "packages/coding-agent/src/cli.ts");
		const counter = path.join(home, "attempts");
		const failUntil = path.join(home, "fail-until");
		fs.writeFileSync(failUntil, "1");
		fs.mkdirSync(path.dirname(cli), { recursive: true });
		fs.writeFileSync(
			cli,
			`
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const file = ${JSON.stringify(counter)};
const attempt = existsSync(file) ? Number(readFileSync(file, "utf8")) + 1 : 1;
writeFileSync(file, String(attempt));
const message = { role: "assistant", timestamp: attempt, model: "test", content: [{type:"text",text:"answer"}],
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: {total: 0.001} } };
process.stdout.write(JSON.stringify({type:"message_end", message}) + "\\n" +
  JSON.stringify({type:"agent_end", messages:[message]}) + "\\n");
if (attempt <= Number(readFileSync(${JSON.stringify(failUntil)}, "utf8"))) process.exitCode = 1;
`,
		);
		const s = spec([
			{
				id: "agent",
				type: "agent",
				prompt: "answer",
				on_failure: "retry",
				retry: { times: 2, backoff: "linear", max_delay_secs: 0 },
			},
		]);
		s.budget = { max_llm_cost_usd: 0.0015 };
		const r = routine(s);
		await runner.fire(r.id);
		const run = listRuns(r.id)[0]!;
		const attempts = listStepRuns(run.id);
		expect(attempts.map(attempt => attempt.status)).toEqual(["failed", "success"]);
		expect(run.abortReason).toBe("budget");
		expect(run.totalLlmCostMicros).toBe(2000);
		expect(run.totalLlmTokens).toBe(30);
		fs.writeFileSync(counter, "0");
		fs.writeFileSync(failUntil, "2");
		const tokenSpec = spec([
			{
				id: "agent",
				type: "agent",
				prompt: "answer",
				on_failure: "retry",
				retry: { times: 3, backoff: "linear", max_delay_secs: 0 },
			},
		]);
		tokenSpec.budget = { max_llm_tokens_input: 15 };
		const tokenRun = routine(tokenSpec);
		await runner.fire(tokenRun.id);
		const stopped = listRuns(tokenRun.id)[0]!;
		expect(listStepRuns(stopped.id).map(attempt => attempt.status)).toEqual(["failed", "failed"]);
		expect(fs.readFileSync(counter, "utf8")).toBe("2");
		expect(stopped.abortReason).toBe("budget");
		expect(stopped.totalLlmCostMicros).toBe(2000);
		expect(stopped.totalLlmTokens).toBe(30);
	},
	20_000,
	home => [process.execPath, path.join(home, "backend/packages/coding-agent/src/cli.ts")],
);

let selections = 0;
test(
	"a routine pins its agent backend before the first agent step",
	async ({ home, runner }) => {
		selections = 0;
		const marker = path.join(home, "agents");
		for (const name of ["backend-a", "backend-b"]) {
			const cli = path.join(home, name, "cli.ts");
			fs.mkdirSync(path.dirname(cli), { recursive: true });
			fs.writeFileSync(
				cli,
				`
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name + "\n")});
const message = { role: "assistant", timestamp: 1, model: "test",
  content: [{type: "text", text: "answer"}],
  usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: {total: 0.001}} };
process.stdout.write(JSON.stringify({type: "agent_end", messages: [message]}) + "\\n");
`,
			);
		}
		const r = routine(
			spec([
				{ id: "first", type: "agent", prompt: "one" },
				{ id: "second", type: "agent", prompt: "two" },
			]),
		);
		await runner.fire(r.id);
		const run = listRuns(r.id)[0]!;
		expect(listStepRuns(run.id).map(step => step.status)).toEqual(["success", "success"]);
		expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(["backend-a", "backend-a"]);
		expect(selections).toBe(1);
		expect(run.backend).toEqual({ path: path.join(home, "backend-a", "cli.ts"), commit: null, version: null });
		const shell = createShellFixture(home);
		const deckOnly = routine(spec([{ id: "local", type: "run", cwd: shell.cwd, command: shell.command("success") }]));
		await runner.fire(deckOnly.id);
		expect(listRuns(deckOnly.id)[0]?.backend).toBeUndefined();
	},
	undefined,
	home => [process.execPath, path.join(home, ++selections === 1 ? "backend-a" : "backend-b", "cli.ts")],
);

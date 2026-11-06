import { stringifySettingsToml as stringifyToml } from "@oh-my-pi/pi-utils/settings-toml";
import { expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { RoutineSpec } from "@npi-deck/protocol";
import { createV1Routine, listRuns } from "../db/routines.ts";
import { listStepRuns } from "../db/routine-step-runs.ts";
import { createIsolatedTest } from "../test-isolation.ts";
import { RoutineTestFixtures } from "./test-fixture.ts";
import { createShellFixture, shellFixtureCommand } from "./shell-fixture.ts";
import type { ShellFixtureConfig } from "./shell-fixture.ts";
import { resolveBackendSelection } from "../backend/runtime.ts";

const nativeBackend = resolveBackendSelection();
const isolatedTest = createIsolatedTest(import.meta.path, nativeBackend ? { NPI_DECK_BACKEND: nativeBackend.path } : {});

// Model libuv's default CRT argv serialization, not cmd's separate quote parser.
// cmd sees the backslashes before quotes literally, so adding a cmd outer quote
// pair to the old command never reached the executable on Windows.
function crtQuoteArgument(value: string): string {
	if (value && !/[\s"]/.test(value)) return value;
	return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

isolatedTest("Windows fixture keeps path quotes out of Bun's CRT-quoted cmd /c argument", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "npi-shell-command-"));
	try {
		const shell = createShellFixture(home);
		const runtime = "C:\\Program Files\\runtime's folder\\bun.exe";
		const script = path.join(shell.cwd, "routine fixture's runtime.cjs");
		const config = { marker: "C:\\private fixtures\\marker's file", bytes: "yes", newline: true };
		const encoded = Buffer.from(JSON.stringify(config)).toString("base64url");
		const oldCommand = `""${runtime}" "${script}" "write" "${encoded}" "tail-marker""`;
		expect(crtQuoteArgument(oldCommand))
			.toBe(String.raw`"\"\"${runtime}\" \"${script}\" \"write\" \"${encoded}\" \"tail-marker\"\""`);

		const template = shellFixtureCommand(runtime, script, "write", config, "{{ trigger.tag }}", "win32");
		const launcher = template.split(" ")[0]!;
		expect(launcher).toMatch(/^routine-fixture-[a-f0-9-]+\.cmd$/);
		expect(template).toBe(`${launcher} {{ trigger.tag }}`);
		// This is the whole raw command line Bun gives cmd after rendering.
		expect(["cmd", "/c", `${launcher} tail-marker`].map(crtQuoteArgument).join(" "))
			.toBe(`cmd /c "${launcher} tail-marker"`);
		expect(fs.readFileSync(path.join(shell.cwd, launcher), "utf8"))
			.toBe(`@echo off\r\n"${runtime}" "${script}" "write" "${encoded}" "%*"\r\n`);

		const withoutValue = shellFixtureCommand(runtime, script, "success", {}, undefined, "win32");
		expect(crtQuoteArgument(withoutValue)).toBe(withoutValue);
		expect(fs.readFileSync(path.join(shell.cwd, withoutValue), "utf8"))
			.toBe(`@echo off\r\n"${runtime}" "${script}" "success" "e30"\r\n`);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

isolatedTest("fixture bytes, rendered values, cwd and exit 7 round-trip through the production shell", async () => {
	const fixtures = new RoutineTestFixtures();
	await fixtures.run(async ({ home, runner }) => {
		const shell = createShellFixture(home);
		const runtime = path.join(shell.cwd, process.platform === "win32" ? "test runtime's bun.exe" : "test runtime's bun");
		// The real executable itself has spaces and an apostrophe, including in the batch launcher.
		try { fs.linkSync(process.execPath, runtime); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
			fs.copyFileSync(process.execPath, runtime, fs.constants.COPYFILE_FICLONE);
		}
		const script = path.join(shell.cwd, "routine fixture's runtime.cjs");
		const marker = path.join(shell.cwd, "marker's bytes");
		const command = (config: ShellFixtureConfig, value?: string) =>
			shellFixtureCommand(runtime, script, "write", { ...config, marker, expectedCwd: shell.cwd }, value);
		const spec: RoutineSpec = {
			name: "shell round trip", trigger: [{ manual: {} }], concurrency: "skip",
			steps: [
				{ id: "bytes", type: "run", cwd: shell.cwd, command: command({ bytes: "UTF-8 café ' \\ bytes", newline: false }) },
				{ id: "rendered", type: "run", cwd: shell.cwd, command: command({ append: true, newline: true, exitCode: 7 }, "{{ trigger.tag }}") },
			],
		};
		const routine = createV1Routine({ name: "shell round trip", spec, specToml: stringifyToml(spec), enabled: true });
		await runner.fire(routine.id, "manual", { tag: "tail-marker" });
		const run = listRuns(routine.id)[0]!;
		expect(listStepRuns(run.id).map(step => [step.status, step.error])).toEqual([
			["success", undefined], ["failed", "exit code 7"],
		]);
		expect(fs.readFileSync(marker, "utf8")).toBe("UTF-8 café ' \\ bytestail-marker\n");
		expect(run.abortReason).toBe("failure");
	});
});

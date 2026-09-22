import { describe, expect, test } from "bun:test";
import { resolveOmompUpdateArgv } from "@oh-my-pi/pi-coding-agent/cli/omomp-update";
import updatePrompt from "../src/prompts/omomp-update.md" with { type: "text" };

describe("resolveOmompUpdateArgv", () => {
	test("routes the npi executable's exact update command into a prompted launch", () => {
		expect(resolveOmompUpdateArgv(["update"], "/home/user/.local/bin/npi")).toEqual([
			"launch",
			updatePrompt.trim(),
		]);
	});

	test("still routes a legacy omomp install so it does not hit the upstream updater", () => {
		expect(resolveOmompUpdateArgv(["update"], "/home/user/.local/bin/omomp")[0]).toBe("launch");
	});

	test("recognizes the Windows executable name case-insensitively", () => {
		expect(resolveOmompUpdateArgv(["update"], "C:\\Users\\user\\npi.EXE")[0]).toBe("launch");
	});

	test("preserves the upstream omp update command", () => {
		expect(resolveOmompUpdateArgv(["update"], "/home/user/.local/bin/omp")).toEqual(["update"]);
	});

	test("does not swallow update flags or help", () => {
		expect(resolveOmompUpdateArgv(["update", "--check"], "/home/user/.local/bin/omomp")).toEqual([
			"update",
			"--check",
		]);
		expect(resolveOmompUpdateArgv(["update", "--help"], "/home/user/.local/bin/omomp")).toEqual(["update", "--help"]);
	});
});

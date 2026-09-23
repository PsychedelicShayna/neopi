import { describe, expect, test } from "bun:test";
import { resolveNpiUpdateArgv } from "../src/cli/npi-update";
import updatePrompt from "../src/prompts/npi-update.md" with { type: "text" };

describe("resolveNpiUpdateArgv", () => {
	test("routes the npi executable's exact update command into a prompted launch", () => {
		expect(resolveNpiUpdateArgv(["update"], "/home/user/.local/bin/npi")).toEqual(["launch", updatePrompt.trim()]);
	});

	test("recognizes the Windows executable name case-insensitively", () => {
		expect(resolveNpiUpdateArgv(["update"], "C:\\Users\\user\\npi.EXE")[0]).toBe("launch");
	});

	test("preserves the upstream omp update command", () => {
		expect(resolveNpiUpdateArgv(["update"], "/home/user/.local/bin/omp")).toEqual(["update"]);
	});

	test("does not swallow update flags or help", () => {
		expect(resolveNpiUpdateArgv(["update", "--check"], "/home/user/.local/bin/npi")).toEqual(["update", "--check"]);
		expect(resolveNpiUpdateArgv(["update", "--help"], "/home/user/.local/bin/npi")).toEqual(["update", "--help"]);
	});
});

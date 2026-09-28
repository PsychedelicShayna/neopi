import { describe, expect, test } from "bun:test";
import { resolveCliArgv } from "../src/cli-commands";
import { parseArgs } from "../src/cli/args";
import { resolveNpiIdeaArgv } from "../src/cli/npi-idea";

describe("resolveNpiIdeaArgv", () => {
	test("starts a fresh interactive launch with all idea words, including option-like text", () => {
		const idea = "Make --model <fast> accept {{literal}} text";
		const routed = resolveCliArgv(
			resolveNpiIdeaArgv(
				["idea", "Make", "--model", "<fast>", "accept", "{{literal}}", "text"],
				"/home/user/.local/bin/npi",
			),
		);
		if ("error" in routed) throw new Error(routed.error);
		expect(routed.argv[0]).toBe("launch");
		expect(routed.argv).toHaveLength(3);
		const parsed = parseArgs(routed.argv.slice(1));
		expect(parsed.newSession).toBe(true);
		expect(parsed.messages).toHaveLength(1);
		expect(parsed.messages[0]).toContain(idea);
	});

	test("does not intercept omp or idea without an argument", () => {
		expect(resolveNpiIdeaArgv(["idea", "feature"], "/usr/bin/omp")).toEqual(["idea", "feature"]);
		expect(resolveNpiIdeaArgv(["idea"], "/home/user/.local/bin/npi")).toEqual(["idea"]);
	});
});

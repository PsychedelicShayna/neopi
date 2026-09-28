import { describe, expect, test } from "bun:test";
import { resolveCliArgv } from "../src/cli-commands";
import { resolveNpiIdeaArgv } from "../src/cli/npi-idea";

describe("resolveNpiIdeaArgv", () => {
	test("starts one interactive launch with all idea words, including option-like text", () => {
		const idea = "Make --model <fast> accept {{literal}} text";
		const routed = resolveCliArgv(
			resolveNpiIdeaArgv(
				["idea", "Make", "--model", "<fast>", "accept", "{{literal}}", "text"],
				"/home/user/.local/bin/npi",
			),
		);
		if ("error" in routed) throw new Error(routed.error);
		expect(routed.argv[0]).toBe("launch");
		expect(routed.argv).toHaveLength(2);
		expect(routed.argv[1]).toContain(idea);
	});

	test("does not intercept omp or idea without an argument", () => {
		expect(resolveNpiIdeaArgv(["idea", "feature"], "/usr/bin/omp")).toEqual(["idea", "feature"]);
		expect(resolveNpiIdeaArgv(["idea"], "/home/user/.local/bin/npi")).toEqual(["idea"]);
	});
});

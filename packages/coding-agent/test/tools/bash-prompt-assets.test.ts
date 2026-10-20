import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

describe("BashTool prompt asset overrides", () => {
	let cwd: string;
	let overridePath: string;
	let tool: BashTool;

	beforeEach(async () => {
		const scratch = path.join(os.homedir(), ".cache", "npi-canary");
		await fs.mkdir(scratch, { recursive: true });
		cwd = await fs.mkdtemp(path.join(scratch, "bash-prompt-assets-"));
		overridePath = path.join(cwd, ".omp", "builtin-prompts", "tools", "bash.md");
		const session = {
			cwd,
			settings: Settings.isolated({ "async.enabled": false }),
			isToolActive: (name: string) => name === "grep" || name === "bash",
		} as unknown as ToolSession;
		tool = new BashTool(session);
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("renders a project override and reloads it on the same tool instance", async () => {
		await Bun.write(overridePath, "custom {{#if hasGrep}}grep{{/if}} async={{asyncEnabled}}");
		expect(tool.description).toBe("custom grep async=false");

		await Bun.write(overridePath, "reloaded {{#unless hasRead}}no-read{{/unless}}");
		expect(tool.description).toBe("reloaded no-read");
	});

	it("restores the previous effective description after removing the override", async () => {
		const original = tool.description;
		await Bun.write(overridePath, "project description");
		expect(tool.description).toBe("project description");

		await fs.unlink(overridePath);
		expect(tool.description).toBe(original);
	});

	it("fails closed when a previously valid description override becomes malformed", async () => {
		await Bun.write(overridePath, "valid description");
		expect(tool.description).toBe("valid description");

		await Bun.write(overridePath, "{{#if hasGrep}}broken");
		expect(() => tool.description).toThrow();
	});
});

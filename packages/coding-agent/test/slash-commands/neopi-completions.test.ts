import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";

async function complete(command: string, prefix: string) {
	const spec = lookupBuiltinSlashCommand(command);
	const items = await spec?.getTuiArgumentCompletions?.(prefix, undefined);
	return (items ?? []).map(item => ({ value: item.value, submitsCommand: item.submitsCommand === true }));
}

describe("NeoPi command completion", () => {
	let dir: string;
	let previous: string;

	beforeEach(async () => {
		previous = getAgentDir();
		dir = path.join(previous, `neopi-completions-${Bun.randomUUIDv7()}`);
		await fs.mkdir(dir, { recursive: true });
		setAgentDir(dir);
		await Bun.write(
			path.join(dir, "neopi-persona.json"),
			JSON.stringify({
				schemaVersion: 1,
				personas: { reviewer: { mode: "replace", source: { kind: "inline", content: "Review." } } },
				sessionPersonas: {},
			}),
		);
		await Bun.write(
			path.join(dir, "neopi-live-personas.json"),
			JSON.stringify({ schemaVersion: 1, personas: { iris: { instructions: "Iris." } } }),
		);
	});

	afterEach(async () => {
		setAgentDir(previous);
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("runs argument-free subcommands on accept and waits for a name after set", async () => {
		expect(await complete("persona", "s")).toEqual([
			{ value: "set ", submitsCommand: false },
			{ value: "show ", submitsCommand: false },
			{ value: "status ", submitsCommand: true },
		]);
	});

	it("completes persona names per scope, and a name completes the command", async () => {
		expect(await complete("persona", "set r")).toEqual([{ value: "set reviewer", submitsCommand: true }]);
		expect(await complete("persona", "live set ")).toEqual([
			{ value: "live set default", submitsCommand: true },
			{ value: "live set iris", submitsCommand: true },
		]);
	});

	it("keeps clone open for the new name", async () => {
		expect(await complete("persona", "clone rev")).toEqual([{ value: "clone reviewer ", submitsCommand: false }]);
	});

	it("offers only the resettable kernels", async () => {
		expect((await complete("kernel", "reset ")).map(item => item.value)).toEqual(["reset js", "reset py"]);
	});
});

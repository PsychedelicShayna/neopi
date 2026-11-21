import { describe, expect, it } from "bun:test";
import { argumentValues, buildArgumentCompletions } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-completions";
import {
	BUILTIN_SLASH_COMMANDS,
	BUILTIN_SLASH_COMMANDS_INTERNAL,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui";

describe("declarative subcommand completion", () => {
	it("gives the selected dropdown item the same ghost text as the closed-dropdown hint", async () => {
		const changelog = BUILTIN_SLASH_COMMANDS.find(command => command.name === "changelog");
		const items = await changelog?.getArgumentCompletions?.("la");
		const inlineHint = changelog?.getInlineHint?.("la") ?? undefined;

		expect(inlineHint).toBeTruthy();
		expect(items?.map(item => item.hint)).toEqual([inlineHint]);
	});

	it("offers all three /roles scopes as selectable completions", async () => {
		const provider = new CombinedAutocompleteProvider([...BUILTIN_SLASH_COMMANDS], process.cwd());
		const input = "/roles ";
		const suggestions = await provider.getSuggestions([input], 0, input.length);
		expect(suggestions?.items.map(item => item.label)).toEqual(["session", "project", "global"]);
		expect(
			suggestions?.items.map(
				item => provider.applyCompletion([input], 0, input.length, item, suggestions.prefix).lines,
			),
		).toEqual([["/roles session "], ["/roles project "], ["/roles global "]]);
	});

	it("retains quoted fields while completing a later argument of a multiword verb", async () => {
		const complete = buildArgumentCompletions([
			{ name: "config", description: "Configure" },
			{
				name: "config set",
				description: "Set configuration",
				usage: "<name> <on|off>",
				arguments: [null, argumentValues("on", "off")],
			},
		]);
		expect((await complete("config "))?.map(item => item.label)).toEqual(["config set"]);
		expect(await complete("config set name")).toBeNull();
		expect((await complete('Config  set "other name" of'))?.map(item => item.value)).toEqual([
			'Config  set "other name" off ',
		]);
	});

	it.each([
		["settings", "session c", "session clear"],
		["settings", "project ", "project clear"],
		["chron", "off --c", "off --confirm"],
		["goal", "budget o", "budget off"],
		["advisor", "dump r", "dump raw"],
		["live", "model gpt-live-1.1", "model gpt-live-1.1-codex"],
	])("completes /%s %s to the hinted value", async (name, prefix, expected) => {
		const command = BUILTIN_SLASH_COMMANDS.find(candidate => candidate.name === name);
		const items = await command?.getArgumentCompletions?.(prefix);
		expect(items?.map(item => item.value.trimEnd())).toContain(expected);
	});

	it("requires a completion source for hints containing a flag or alternatives", () => {
		const missing: string[] = [];
		for (const command of BUILTIN_SLASH_COMMANDS_INTERNAL) {
			for (const verb of command.subcommands ?? []) {
				if (command.getTuiArgumentCompletions || verb.getArgumentCompletions) continue;
				// For positional declarations, an alternative in the second slot
				// needs a second provider; the first slot's provider isn't enough.
				const slots = verb.usage?.match(/(?:\[[^\]]*\]|<[^>]*>|\S)+/g) ?? [];
				for (const [index, slot] of slots.entries()) {
					if (/(?:--[a-z][\w-]*|\|)/i.test(slot) && !verb.arguments?.[index]) {
						missing.push(`/${command.name} ${verb.name}: ${slot}`);
					}
				}
			}
		}
		expect(missing).toEqual([]);
	});

	it("keeps live choices wired where the hint names a collection rather than literal values", () => {
		const collections = {
			advisor: ["dump"],
			chain: ["use"],
			jobs: ["kill"],
			live: ["model"],
			marketplace: ["remove", "update", "discover", "install", "uninstall", "upgrade"],
			memory: ["mm show", "mm history", "mm delete", "mm refresh"],
			moa: ["configure", "use"],
			modelpreset: ["switch", "delete"],
			plugins: ["enable", "disable"],
			session: ["pin"],
			ssh: ["remove"],
			todo: ["append", "start", "done", "drop", "rm", "import", "export"],
			usage: ["reset"],
		};
		const missing: string[] = [];
		for (const [name, verbs] of Object.entries(collections)) {
			const command = BUILTIN_SLASH_COMMANDS_INTERNAL.find(spec => spec.name === name);
			if (command?.getTuiArgumentCompletions) continue;
			for (const nameOfVerb of verbs) {
				const verb = command?.subcommands?.find(sub => sub.name === nameOfVerb);
				if (!verb?.getArgumentCompletions && !verb?.arguments?.some(Boolean)) {
					missing.push(`/${name} ${nameOfVerb}`);
				}
			}
		}
		for (const name of [
			"add-dir",
			"cleanse",
			"copy",
			"defer",
			"export",
			"force",
			"git",
			"hub",
			"irc",
			"login",
			"logout",
			"loop",
			"model",
			"open",
			"pin",
			"remove-dir",
			"resume",
			"stats",
			"tool",
			"unpin",
		]) {
			if (!BUILTIN_SLASH_COMMANDS.find(command => command.name === name)?.getArgumentCompletions) {
				missing.push(`/${name}`);
			}
		}
		expect(missing).toEqual([]);
	});

	it("does not treat Enter in an untouched kill target slot as kill all", async () => {
		const command = BUILTIN_SLASH_COMMANDS.find(candidate => candidate.name === "jobs");
		const items = await command?.getArgumentCompletions?.("kill ");
		expect(items?.find(item => item.label === "all")?.preserveInputOnSubmit).toBe(true);
	});

	it.each(["chron", "fork"])("offers /%s verbs before a prefix without stealing bare Enter", async name => {
		const command = BUILTIN_SLASH_COMMANDS.find(candidate => candidate.name === name);
		const items = await command?.getArgumentCompletions?.("");
		expect(items?.length).toBeGreaterThan(1);
		expect(items?.every(item => item.preserveInputOnSubmit)).toBe(true);
	});
});

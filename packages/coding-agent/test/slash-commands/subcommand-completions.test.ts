import { describe, expect, it } from "bun:test";
import { BUILTIN_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
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
});

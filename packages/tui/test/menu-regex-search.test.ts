import { describe, expect, it } from "bun:test";
import { MenuSearchField } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { FuzzyCorpus, FuzzyQuery, FuzzyText, fuzzyFilter, fuzzyMatch } from "@oh-my-pi/pi-tui/fuzzy";

const labels = ["Live voice", "Voice input", "Delivery", "Revoice"];

describe("menu regex search", () => {
	it("uses bare very-magic alternation and directional word boundaries for both prefixes", () => {
		for (const prefix of ["/", "re:"]) {
			const query = `${prefix}<live|<voice>`;
			expect(fuzzyFilter(labels, query, text => text)).toEqual(["Live voice", "Voice input"]);
			expect(new FuzzyCorpus(labels, text => text).rank(query).map(result => result.item)).toEqual([
				"Live voice", "Voice input",
			]);
			expect(new FuzzyText("Live voice").match(query).matches).toBe(true);
			expect(new FuzzyQuery(query).match("Revoice").matches).toBe(false);
		}
	});

	it("shows invalid regex inline and matches nothing without throwing", () => {
		const field = new MenuSearchField("/[", true);
		expect(fuzzyFilter(labels, field.value, text => text)).toEqual([]);
		expect(field.render(120, { muted: text => text })).toContain("Invalid regex");
		field.setValue("/voice");
		expect(field.render(120, { muted: text => text })).not.toContain("Invalid regex");
	});

	it.each([
		[String.raw`/^a.b*$`, "axb", true],
		[String.raw`/^a\+b\?$`, "a+b?", true],
		[String.raw`/^a+b?$`, "aaab", true],
		[String.raw`/^(live|voice){1,2}$`, "livevoice", true],
		[String.raw`/^\d+\s\w+$`, "12 voice", true],
		[String.raw`/\C^[A-Z]{2,}\.[a-z]*$`, "AB.voice", true],
		[String.raw`/\C^[A-Z]{2,}\.[a-z]*$`, "ab.voice", false],
		[String.raw`/\Cvoice`, "VOICE", false],
		[String.raw`/\C\cvoice`, "VOICE", true],
		[String.raw`/\v^(live|voice)+$`, "livevoice", true],
		[String.raw`/\Vlive.*[voice]+?`, "live.*[voice]+?", true],
		[String.raw`/\m^live|voice(){}+?$`, "live|voice(){}+?", true],
		[String.raw`/\m^\(live\|voice\)\{1,2}$`, "livevoice", true],
		[String.raw`/\m\<voice\>`, "Revoice", false],
		[String.raw`/\M^a\.b$`, "axb", true],
		[String.raw`/\<voice\>`, "<voice>", true],
		[String.raw`/\<voice\>`, "voice", false],
	])("translates %s against %s", (pattern, text, expected) => {
		expect(fuzzyMatch(pattern, text).matches).toBe(expected);
	});

	it("keeps ordinary fuzzy search unchanged", () => {
		expect(fuzzyMatch("vce", "Voice input").matches).toBe(true);
	});
});

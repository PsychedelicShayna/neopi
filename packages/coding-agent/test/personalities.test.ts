import { describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { cfgCustomPersonalities } from "../src/session/settings";
import {
	saveCustomPersonality,
	savePersonalityDefinitions,
	listCustomPersonalities,
} from "../src/neopi/personality-settings";
import {
	completePersonalityNames,
	resolvePersonalities,
	resolvePersonalityRecords,
	validatePersonalityDefinition,
} from "../src/neopi/personalities";

describe("scoped personalities", () => {
	it("completes personality names without changing their spelling", () => {
		expect(completePersonalityNames(["friendly", "Warm", "work"], "W")).toEqual(["Warm", "work"]);
	});
	it("reports the winning source for settings records", () => {
		expect(resolvePersonalityRecords({ global: { warm: "old" }, project: { warm: "new" } })).toEqual([
			{ name: "warm", prompt: "new", scope: "project" },
		]);
	});
	it("protects built-in names and rejects empty names and prompts", () => {
		expect(validatePersonalityDefinition({ name: "Friendly", prompt: "hello" })).toBeDefined();
		expect(validatePersonalityDefinition({ name: "", prompt: "hello" })).toBeDefined();
		expect(validatePersonalityDefinition({ name: "mine", prompt: " " })).toBeDefined();
		expect(validatePersonalityDefinition({ name: "mine", prompt: "hello" })).toBeUndefined();
	});
	it("resolves same-named definitions by settings precedence without losing other names", () => {
		const result = resolvePersonalities({
			global: [
				{ name: "warm", prompt: "global" },
				{ name: "other", prompt: "other" },
			],
			project: [{ name: "warm", prompt: "project" }],
			session: [{ name: "warm", prompt: "session" }],
		});
		expect(result).toEqual([
			{ name: "other", prompt: "other", scope: "global" },
			{ name: "warm", prompt: "session", scope: "session" },
		]);
	});
});

it("saves a scope atomically without copying inherited personalities", () => {
	const settings = Settings.isolated();
	saveCustomPersonality(settings, "global", "inherited", "global text");
	saveCustomPersonality(settings, "project", "removed", "old text");
	savePersonalityDefinitions(settings, "project", [
		{ name: "inherited", prompt: "global text" },
		{ name: "new", prompt: "project text" },
	]);
	expect(settings.readScopeValue(cfgCustomPersonalities, "project")).toEqual({ new: "project text" });
	expect(listCustomPersonalities(settings).map(entry => entry.name)).toEqual(["inherited", "new"]);
	expect(() =>
		savePersonalityDefinitions(settings, "project", [
			{ name: "valid", prompt: "text" },
			{ name: "friendly", prompt: "invalid" },
		]),
	).toThrow();
	expect(settings.readScopeValue(cfgCustomPersonalities, "project")).toEqual({ new: "project text" });
});

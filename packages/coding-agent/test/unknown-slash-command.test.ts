import { describe, expect, it } from "bun:test";
import { findUnknownSlashCommand } from "../src/modes/utils/unknown-slash-command";

const KNOWN = ["rename", "resume", "model", "skill:grilling", "q"];

describe("findUnknownSlashCommand", () => {
	it("suggests the closest command for a typo", () => {
		expect(findUnknownSlashCommand("/reename Issue Tracker", KNOWN)).toEqual({
			name: "reename",
			suggestion: "rename",
		});
	});

	it("flags an unknown command without a suggestion when nothing is within two edits", () => {
		expect(findUnknownSlashCommand("/title NeoPi Issue Conveyor Belt", KNOWN)).toEqual({ name: "title" });
	});

	it("passes known commands, aliases, and namespaced commands through", () => {
		expect(findUnknownSlashCommand("/rename x", KNOWN)).toBeUndefined();
		expect(findUnknownSlashCommand("/q", KNOWN)).toBeUndefined();
		expect(findUnknownSlashCommand("/skill:grilling plan", KNOWN)).toBeUndefined();
		expect(findUnknownSlashCommand("/model:opus", KNOWN)).toBeUndefined();
	});

	it("flags an unknown namespaced command", () => {
		expect(findUnknownSlashCommand("/skill:griling", KNOWN)).toEqual({
			name: "skill:griling",
			suggestion: "skill:grilling",
		});
	});

	it("ignores paths and text that is not a leading command token", () => {
		expect(findUnknownSlashCommand("/etc/hosts is wrong", KNOWN)).toBeUndefined();
		expect(findUnknownSlashCommand("/home/shayna/foo.ts:12 fails", KNOWN)).toBeUndefined();
		expect(findUnknownSlashCommand("fix /reename please", KNOWN)).toBeUndefined();
		expect(findUnknownSlashCommand("/ spaced", KNOWN)).toBeUndefined();
		expect(findUnknownSlashCommand("/123", KNOWN)).toBeUndefined();
	});
});

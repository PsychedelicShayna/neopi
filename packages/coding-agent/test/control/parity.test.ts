/**
 * The control socket's command inventory is the RPC command union.
 * A missing RPC command fails typecheck in parity.ts. Dropping a slash
 * command or keybinding fails the counts below.
 */
import { describe, expect, test } from "bun:test";
import { RPC_COMMAND_TYPES } from "../../src/control/parity";
import { BUILTIN_SLASH_COMMAND_DEFS } from "../../src/slash-commands/builtin-registry";
import { KEYBINDINGS } from "@oh-my-pi/pi-tui/app-keybindings";
import { TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui/keybindings";

describe("control parity inventory", () => {
	test("every RPC command is in the route inventory", () => {
		expect(new Set(RPC_COMMAND_TYPES).size).toBe(53);
		expect(RPC_COMMAND_TYPES.length).toBe(53);
	});

	test("slash commands and keybindings match this tree", () => {
		const aliases = BUILTIN_SLASH_COMMAND_DEFS.reduce((count, command) => count + (command.aliases?.length ?? 0), 0);
		const appIds = Object.keys(KEYBINDINGS).filter(id => id.startsWith("app."));
		// origin/neopi. The plan counted 77 action ids here. INTEGRATE adds the
		// neopi slash commands and app.repl.*, checked when this rebases there.
		expect(BUILTIN_SLASH_COMMAND_DEFS.length).toBe(84);
		expect(aliases).toBe(8);
		expect(appIds.length).toBe(45);
		expect(Object.keys(TUI_KEYBINDINGS).length).toBe(32);
	});
});

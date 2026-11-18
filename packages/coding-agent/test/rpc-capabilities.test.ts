import { describe, expect, test } from "bun:test";
import { RPC_COMMAND_TYPES } from "@oh-my-pi/pi-coding-agent/control/parity";
import { RPC_CAPABILITIES } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-capabilities";
import { rpcCommands } from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/commands";

/** Capabilities whose string is the name of the command they advertise. */
const COMMAND_CAPABILITIES = ["set_subagent_model", "cycle_role", "abort_and_restore_queue"];
/** Capabilities whose commands carry another name. */
const NAMED_COMMAND_CAPABILITIES: Record<string, string> = {
	command_completions: "get_command_completions",
	subagent_history: "get_subagent_history",
};

describe("RPC ready capabilities", () => {
	test("never repeat a string", () => {
		expect(new Set(RPC_CAPABILITIES).size).toBe(RPC_CAPABILITIES.length);
	});

	test.each(COMMAND_CAPABILITIES)("%s is advertised with the command it names, over stdio and control", capability => {
		expect(RPC_CAPABILITIES).toContain(capability);
		expect(rpcCommands.map(command => command.name)).toContain(capability);
		expect(RPC_COMMAND_TYPES).toContain(capability as (typeof RPC_COMMAND_TYPES)[number]);
	});

	test.each(Object.entries(NAMED_COMMAND_CAPABILITIES))(
		"%s advertises %s, over stdio and control",
		(capability, command) => {
			expect(RPC_CAPABILITIES).toContain(capability);
			expect(rpcCommands.map(spec => spec.name)).toContain(command);
			expect(RPC_COMMAND_TYPES).toContain(command as (typeof RPC_COMMAND_TYPES)[number]);
		},
	);
});

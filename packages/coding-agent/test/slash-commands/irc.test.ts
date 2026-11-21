import { afterEach, expect, it, vi } from "bun:test";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { IrcBus } from "../../src/irc/bus";
import { registerIrcOperator } from "../../src/irc/operator";
import type { InteractiveModeContext } from "../../src/modes/types";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSessionHandle } from "../../src/session/agent-session-handle";
import { executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";

let unregister: (() => void) | undefined;
afterEach(() => {
	IrcBus.resetGlobalForTests();
	unregister?.();
});

it("lets the operator create, list, manage, and message a named IRC group", async () => {
	const registry = new AgentRegistry();
	IrcBus.installGlobal(new IrcBus(registry));
	unregister = registerIrcOperator(registry, "Human", "Main");
	const received: IrcMessage[] = [];
	const session = {
		deliverIrcMessage: async (message: IrcMessage) => {
			received.push(message);
			return "injected";
		},
	} as unknown as AgentSessionHandle;
	registry.register({ id: "Scout", kind: "sub", displayName: "Scout", session });
	registry.register({ id: "Reviewer", kind: "sub", displayName: "Reviewer", session });
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const showIrcViewer = vi.fn();
	const ctx = { ircOperatorId: "Human", showStatus, showWarning, showIrcViewer } as unknown as InteractiveModeContext;
	const run = (text: string) => executeBuiltinSlashCommand(text, { ctx, draftDetached: true });

	expect(await run("/irc")).toBe(true);
	expect(showIrcViewer).toHaveBeenCalledTimes(1);
	await run("/irc group create Review Human Scout");
	expect(showStatus).toHaveBeenLastCalledWith("Created IRC group Review; added Human, Scout.");
	await run("/irc group list");
	expect(showStatus).toHaveBeenLastCalledWith("everyone (3)\nReview (2)");
	await run("/irc group add Review Reviewer");
	await run("/irc group remove Review Scout");
	await run("/irc group members Review");
	expect(showStatus).toHaveBeenLastCalledWith("Members of IRC group Review: Human, Reviewer.");
	received.length = 0;
	await run("/irc #Review Compare results.");
	expect(received).toMatchObject([
		{
			from: "Human",
			to: "Reviewer",
			body: "The operator sent this to group Review, which you are part of.\n\nCompare results.",
		},
	]);
	expect(showWarning).not.toHaveBeenCalled();
});

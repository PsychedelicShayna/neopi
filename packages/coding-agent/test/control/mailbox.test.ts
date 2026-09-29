/**
 * A control mailbox keeps a reply that arrives before anyone is waiting,
 * and a mouse report round-trips through the same parser the pane uses.
 */
import { describe, expect, test } from "bun:test";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { IrcBus } from "../../src/irc/bus";
import { encodeSgrMouse } from "../../src/control/keys";
import { parseSgrMouse } from "@oh-my-pi/pi-tui/mouse";

describe("control mailbox", () => {
	test("a reply queued before wait is still there for a later inbox read", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "ctl:abcd1234",
			displayName: "⌁ control",
			kind: "mailbox",
			session: null,
			status: "idle",
		});
		registry.register({
			id: "peer",
			displayName: "peer",
			kind: "sub",
			session: null,
			status: "idle",
		});
		const bus = new IrcBus(registry);
		const receipt = await bus.send({ from: "peer", to: "ctl:abcd1234", body: "pong" });
		expect(receipt.outcome).toBe("queued");
		expect(bus.peek("ctl:abcd1234").map(message => message.body)).toEqual(["pong"]);
		expect(bus.take("ctl:abcd1234")?.body).toBe("pong");
		expect(bus.take("ctl:abcd1234")).toBeUndefined();
	});
});

describe("control mouse", () => {
	test("a click encodes to the SGR report the pane parses", () => {
		const parsed = parseSgrMouse(encodeSgrMouse(3, 4, "click"));
		expect(parsed?.col).toBe(3);
		expect(parsed?.row).toBe(4);
		expect(parsed?.leftClick).toBe(true);
	});
});

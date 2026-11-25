import { beforeAll, describe, expect, it } from "bun:test";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { IrcMessageBlock } from "@oh-my-pi/pi-tui/chat/irc-message";
import type { CustomMessage } from "@oh-my-pi/pi-tui/chat/messages";
import type { TranscriptEntryLike } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { buildIrcMessageCard } from "@oh-my-pi/pi-tui/chat/transcript-render-helpers";
import { agentColored, noteAgentArrival } from "@oh-my-pi/pi-tui/overlays/agent-identity";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { TUI } from "@oh-my-pi/pi-tui/tui";
import { VirtualTerminal } from "./virtual-terminal";

beforeAll(async () => {
	await initTheme(false);
	noteAgentArrival("IrcBlockScout", 1);
	noteAgentArrival("IrcBlockBuilder", 2);
});

const SENT_AT = new Date(2026, 10, 24, 14, 2, 11).getTime();

function plain(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row));
}

describe("IrcMessageBlock", () => {
	it("shows a long message whole, with no preview cut and no expand hint", () => {
		const body = Array.from({ length: 60 }, (_, index) => `line ${index} ${"word ".repeat(30)}END-${index}`).join(
			"\n\n",
		);
		const rows = plain(new IrcMessageBlock({ kind: "incoming", from: "IrcBlockScout", body }).render(100));
		const text = rows.join("\n");
		for (let index = 0; index < 60; index++) expect(text).toContain(`END-${index}`);
		expect(text).not.toContain("more line");
		expect(text).not.toContain("Expand");
		expect(text).not.toContain("…");
		for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(100);
	});

	it("opens and closes with rules that cannot be mistaken for each other, and rails every body row", () => {
		const block = new IrcMessageBlock({
			kind: "incoming",
			from: "IrcBlockScout",
			body: "first paragraph\n\nsecond paragraph",
			timestamp: SENT_AT,
		});
		const rows = block.render(60);
		const text = plain(rows);
		const box = theme.boxRound;
		expect(text[0]!.startsWith(`${box.topLeft}${box.horizontal} ${theme.symbol("tool.irc")} IrcBlockScout `)).toBe(
			true,
		);
		// Only the opening rule carries the envelope and the time sent.
		expect(text[0]!.endsWith(" 14:02:11")).toBe(true);
		const last = text[text.length - 1]!;
		expect(last.startsWith(`${box.bottomLeft}${box.horizontal} IrcBlockScout `)).toBe(true);
		expect(last).not.toContain(theme.symbol("tool.irc"));
		expect(last).not.toContain("14:02:11");
		for (const row of [text[0]!, last]) expect(Bun.stringWidth(row)).toBe(60);
		// Every row between them, blank ones included, starts with the sender's rail.
		const body = rows.slice(1, -1);
		expect(body.length).toBeGreaterThanOrEqual(3);
		for (const row of body)
			expect(row.startsWith(`${agentColored(theme, "IrcBlockScout", box.vertical)} `)).toBe(true);
	});

	it("draws rules, rail and name in the sender's Agent Hub colour, a different one per agent", () => {
		const rowsOf = (from: string) => new IrcMessageBlock({ kind: "incoming", from, body: "hello" }).render(40);
		const scout = rowsOf("IrcBlockScout");
		const builder = rowsOf("IrcBlockBuilder");
		const box = theme.boxRound;
		expect(scout[0]).toContain(agentColored(theme, "IrcBlockScout", `${box.topLeft}${box.horizontal} `));
		expect(scout[0]).toContain(agentColored(theme, "IrcBlockScout", theme.bold("IrcBlockScout")));
		expect(scout[2]).toContain(agentColored(theme, "IrcBlockScout", "IrcBlockScout"));
		expect(builder[0]).toContain(agentColored(theme, "IrcBlockBuilder", `${box.topLeft}${box.horizontal} `));
		expect(agentColored(theme, "IrcBlockScout", "x")).not.toBe(agentColored(theme, "IrcBlockBuilder", "x"));
	});

	it("names the group a message was sent to, the groups both ends share, and a relay's recipient", () => {
		const head = (view: ConstructorParameters<typeof IrcMessageBlock>[0]) =>
			plain(new IrcMessageBlock(view).render(100))[0]!;
		const arrow = theme.nav.selected;
		const group = head({
			kind: "incoming",
			from: "IrcBlockScout",
			body: "Round 2 is in.",
			group: "council",
			sentToGroup: true,
			broadcast: true,
			sharedGroups: ["review", "docs"],
		});
		expect(group).toContain(`IrcBlockScout ${arrow} #council`);
		expect(group).toContain("shared #review #docs");
		// The group already says it went to several agents.
		expect(group).not.toContain("broadcast");

		expect(head({ kind: "incoming", from: "IrcBlockScout", body: "all hands", broadcast: true })).toContain(
			"broadcast",
		);
		const relay = head({ kind: "relay", from: "IrcBlockScout", to: "IrcBlockBuilder", body: "ack", replyTo: "m1" });
		expect(relay).toContain(`IrcBlockScout ${arrow} IrcBlockBuilder`);
		expect(relay).toContain("reply");
		// A notice about a group is not a message sent to it.
		const notice = head({ kind: "incoming", from: "IrcBlockScout", body: "You were added.", group: "council" });
		expect(notice).not.toContain(arrow);
		expect(notice).toContain("#council");
	});

	it("strips control sequences and tabs from the sender, the group and the body", () => {
		const block = new IrcMessageBlock({
			kind: "incoming",
			from: "Evil\u001b[31m\nName",
			body: "col\tumn \u001b[2Jwiped\u0007",
			group: "g\u001b[0m\nx",
			sentToGroup: true,
		});
		const rows = block.render(60);
		const text = plain(rows).join("\n");
		expect(rows.join("\n")).not.toContain("\u001b[2J");
		expect(rows.join("\n")).not.toContain("\u0007");
		expect(rows.join("\n")).not.toContain("\t");
		expect(text).toContain("Evil Name");
		expect(text).toContain("#g x");
		expect(text).toContain("wiped");
		// The sender's line break did not open an extra row: opening rule, one body row, closing rule.
		expect(rows).toHaveLength(3);
		expect(JSON.stringify(block.describe())).not.toContain("\\u001b");
	});

	it("never overflows a narrow row", () => {
		const block = new IrcMessageBlock({
			kind: "incoming",
			from: "IrcBlockScout",
			body: "a fairly long body that has to wrap many times",
			group: "council",
			sentToGroup: true,
			timestamp: SENT_AT,
		});
		for (const width of [1, 2, 3, 4, 8, 16, 24]) {
			const rows = plain(block.render(width));
			for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
		}
		// Too narrow for both: the time goes first, the sender stays.
		expect(plain(block.render(24))[0]).not.toContain("14:02:11");
		expect(plain(block.render(24))[0]).toContain("IrcBlock");
	});
});

describe("IRC messages in a rebuilt transcript", () => {
	const text = "Compare findings.\n\n- one\n- two";
	const body = `IrcBlockScout sent this to group council, which you are part of.\n\n${text}`;
	const stored: CustomMessage[] = [
		{
			role: "custom",
			customType: "irc:incoming",
			content: "<irc>model-facing envelope</irc>",
			display: true,
			attribution: "agent",
			details: { id: "m1", from: "IrcBlockScout", message: "Direct question?", replyTo: "m0" },
			timestamp: SENT_AT,
		},
		{
			role: "custom",
			customType: "irc:incoming",
			content: "<irc>model-facing envelope</irc>",
			display: true,
			attribution: "agent",
			details: {
				id: "m2",
				from: "IrcBlockScout",
				message: body,
				broadcast: true,
				group: "council",
				groupText: text,
				sharedGroups: ["review"],
				fanoutId: "f1",
			},
			timestamp: SENT_AT + 1000,
		},
	];

	it("renders stored entries exactly as the live transcript rendered them", () => {
		const builder = new ChatTranscriptBuilder({
			ui: new TUI(new VirtualTerminal(100, 30)),
			cwd: "/tmp",
			requestRender: () => {},
		});
		const entries: TranscriptEntryLike[] = stored.map((message, index) => ({
			type: "custom_message",
			id: `irc-${index}`,
			parentId: index === 0 ? null : `irc-${index - 1}`,
			timestamp: new Date(message.timestamp).toISOString(),
			customType: message.customType,
			content: message.content,
			display: true,
			attribution: "agent",
			details: message.details,
		}));
		try {
			for (let rebuild = 0; rebuild < 2; rebuild++) {
				builder.rebuild(entries);
				expect(builder.container.children).toHaveLength(2);
				stored.forEach((message, index) => {
					const live = buildIrcMessageCard(message, () => false).render(90);
					expect(builder.container.children[index]!.render(90)).toEqual(live);
				});
			}
			const group = plain(builder.container.children[1]!.render(90));
			expect(group[0]).toContain(`IrcBlockScout ${theme.nav.selected} #council`);
			expect(group[0]).toContain("shared #review");
			// The sender's own text, without the heading the recipient's model reads, and never the envelope.
			expect(group.join("\n")).toContain("Compare findings.");
			expect(group.join("\n")).not.toContain("sent this to group");
			expect(group.join("\n")).not.toContain("model-facing envelope");
		} finally {
			builder.dispose();
		}
	});
});

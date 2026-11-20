import { beforeAll, expect, test } from "bun:test";
import { ChroniclerMessageCard } from "../src/chat/chronicler-message";
import { ChatTranscriptBuilder } from "../src/chat/chat-transcript-builder";
import type { ChroniclerMessageDetails, CustomMessage } from "../src/chat/messages";
import type { TranscriptEntryLike } from "../src/chat/transcript-entry";
import { initTheme, theme } from "../src/theme";
import { colorToAnsi } from "../src/theme/color";
import { TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

beforeAll(async () => {
	await initTheme(false);
});

function message(): CustomMessage<ChroniclerMessageDetails> {
	return {
		role: "custom",
		customType: "chronicler",
		display: true,
		attribution: "agent",
		timestamp: 1,
		content: "Model-only framing, not the visible note.",
		details: { note: "Acknowledged.\tThis is a long note from Luna that wraps across several lines.\u001b[31m" },
	};
}

test("Luna card draws a blue outline, wraps safely, and distinguishes her visible note from model framing", () => {
	const card = new ChroniclerMessageCard(message(), theme);
	const rows = card.render(36);
	expect(rows[0]).toContain(colorToAnsi(theme.isLight ? "#2563eb" : "#60a5fa", theme.getColorMode()));
	const output = Bun.stripANSI(rows.join("\n"));
	expect(output).toContain("Chronicler Luna");
	expect(output).toContain("Acknowledged.");
	expect(output).not.toContain("Model-only framing");
	expect(output).not.toContain("\t");
	for (const row of rows) expect(Bun.stringWidth(Bun.stripANSI(row))).toBeLessThanOrEqual(36);
	const described = card.describe();
	expect(described.k).toBe("card");
	expect(described.p).toMatchObject({ role: "omp.chronicler", tone: "info" });
	expect(JSON.stringify(described)).not.toContain("\\u001b");
});

test("stored transcript rebuild retains the same Luna card and blue outline", () => {
	const builder = new ChatTranscriptBuilder({
		ui: new TUI(new VirtualTerminal(80, 24)),
		cwd: "/tmp",
		requestRender: () => {},
	});
	const entries: TranscriptEntryLike[] = [
		{
			type: "custom_message",
			id: "luna",
			parentId: null,
			timestamp: "2026-11-11T00:00:00.000Z",
			customType: "chronicler",
			content: message().content,
			display: true,
			attribution: "agent",
			details: message().details,
		},
	];
	try {
		const live = new ChroniclerMessageCard(message(), theme).render(60);
		for (let rebuild = 0; rebuild < 2; rebuild++) {
			builder.rebuild(entries);
			const stored = builder.container.children.find(child => child instanceof ChroniclerMessageCard);
			expect(stored).toBeInstanceOf(ChroniclerMessageCard);
			expect(stored!.render(60)).toEqual(live);
		}
	} finally {
		builder.dispose();
	}
});

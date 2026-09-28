import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { MIXTURE_TRACE_MESSAGE_TYPE, type MixtureTraceDetails } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

type HopTrace = Extract<MixtureTraceDetails, { kind: "hop" | "branch" }>;

function hopTrace(hop: number, memberId: string, output: string | undefined): HopTrace {
	return {
		v: 1,
		runId: "run-1",
		mixture: "draft-then-edit",
		seq: hop,
		at: 0,
		run: {
			status: "running",
			phase: "hop_ready",
			hops: hop,
			usd: 0.01 * hop,
			window: { hops: hop, usd: 0.01 * hop },
		},
		kind: "hop",
		hop,
		memberId,
		model: `fake/${memberId}`,
		output,
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 },
		},
		elapsedMs: 1200,
		status: "done",
		visible: output !== undefined,
	};
}

function answer(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mixture",
		provider: "mixture",
		model: "draft-then-edit",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function card(details: MixtureTraceDetails): CustomMessage<MixtureTraceDetails> {
	return {
		role: "custom",
		customType: MIXTURE_TRACE_MESSAGE_TYPE,
		content: "trace",
		display: true,
		details,
		attribution: "agent",
		timestamp: 0,
	};
}

function text(component: Component): string {
	return Bun.stripANSI(component.render(100).join("\n"));
}

describe("mixture trace cards in the transcript", () => {
	beforeAll(async () => {
		await initTheme(false);
	});
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	it("inserts a live hop card above the streaming answer", async () => {
		const streamingComponent = new AssistantMessageComponent();
		const ctx = createInteractiveModeContext({ streamingComponent });
		ctx.chatContainer.addChild(streamingComponent);
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "mixture_hop_end", details: hopTrace(1, "writer", "the draft") });
		await controller.handleEvent({ type: "mixture_hop_end", details: hopTrace(2, "editor", undefined) });

		const children = ctx.chatContainer.children;
		expect(children.at(-1)).toBe(streamingComponent);
		expect(children.slice(0, -1).map(text)).toEqual([
			expect.stringContaining("◆ draft-then-edit · hop 1 · writer (fake/writer) · $0.01 · 1s"),
			expect.stringContaining("◆ draft-then-edit · hop 2 · editor (fake/editor)"),
		]);
	});

	it("hides live cards when moa.show_trace_cards is off", async () => {
		const streamingComponent = new AssistantMessageComponent();
		const ctx = createInteractiveModeContext({
			streamingComponent,
			settings: Settings.isolated({ "moa.show_trace_cards": false }),
		});
		ctx.chatContainer.addChild(streamingComponent);
		await new EventController(ctx).handleEvent({
			type: "mixture_hop_end",
			details: hopTrace(1, "writer", "the draft"),
		});
		expect(ctx.chatContainer.children).toEqual([streamingComponent]);
	});

	it("renders persisted cards, then the answer, on reload; only the visible hop carries its output body", () => {
		const ctx = createInteractiveModeContext({ toolOutputExpanded: true });
		const helpers = new UiHelpers(ctx);
		for (const message of [
			card(hopTrace(1, "writer", "the draft")),
			card(hopTrace(2, "editor", undefined)),
			answer("The answer."),
		]) {
			helpers.addMessageToChat(message);
		}
		const rendered = ctx.chatContainer.children.map(text);
		expect(rendered).toHaveLength(3);
		expect(rendered[0]).toContain("hop 1 · writer");
		expect(rendered[0]).toContain("the draft");
		expect(rendered[1]).toContain("hop 2 · editor");
		expect(rendered[1]!.split("\n").filter(line => line.trim() !== "")).toHaveLength(1);
		expect(rendered[2]).toContain("The answer.");
	});

	it("strips terminal control sequences from a visible member's output before rendering it", () => {
		const ctx = createInteractiveModeContext({ toolOutputExpanded: true });
		new UiHelpers(ctx).addMessageToChat(
			card(hopTrace(1, "writer", "\x1b[2J\x1b]0;pwned\x07clear\x1b[31m red\x1b[0m\rline\x08 end")),
		);
		const raw = ctx.chatContainer.children[0]!.render(100).join("\n");
		for (const sequence of ["\x1b[2J", "\x1b]0;", "\x07", "\x1b[31m", "\r", "\x08"]) {
			expect(raw).not.toContain(sequence);
		}
		expect(Bun.stripANSI(raw)).toContain("clear redline end");
	});
});

import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it } from "bun:test";
import { IrcViewerComponent, type IrcViewerOptions } from "@oh-my-pi/pi-tui/overlays/irc-viewer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { IrcLogEntry, IrcLogSource } from "@oh-my-pi/pi-tui/tools/irc";

beforeAll(async () => {
	await initTheme();
});

let nextId = 0;
function entry(from: string, to: string, body: string, extra: Partial<IrcLogEntry> = {}): IrcLogEntry {
	nextId += 1;
	return {
		message: { id: `m${nextId}`, from, to, body, ts: Date.UTC(2026, 9, 16, 12, 0, nextId) },
		outcome: "injected",
		broadcast: false,
		...extra,
	};
}

function mount(initial: IrcLogEntry[], rows = 30, extra: Partial<IrcViewerOptions> = {}) {
	const entries = [...initial];
	const listeners = new Set<() => void>();
	let renders = 0;
	let closed = 0;
	const source: IrcLogSource = {
		entries: () => entries,
		subscribe: listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const viewer = new IrcViewerComponent({
		source,
		viewerKeys: ["alt+i"],
		expandKeys: ["ctrl+o"],
		rows: () => rows,
		onClose: () => {
			closed += 1;
		},
		requestRender: () => {
			renders += 1;
		},
		...extra,
	});
	return {
		viewer,
		screen: () => viewer.render(100).map(line => stripVTControlCharacters(line)),
		push: (next: IrcLogEntry) => {
			entries.push(next);
			for (const listener of listeners) listener();
		},
		listenerCount: () => listeners.size,
		renders: () => renders,
		closed: () => closed,
		type: (text: string) => {
			for (const char of text) viewer.handleInput(char);
		},
	};
}

describe("IrcViewerComponent", () => {
	it("fills the screen with each message as sender, arrow, recipient over its body", () => {
		const view = mount([entry("0-Alpha", "0-Beta", "first note"), entry("0-Beta", "Main", "second note")]);
		const screen = view.screen();
		expect(screen).toHaveLength(30);
		const alpha = screen.findIndex(line => line.includes("0-Alpha ➤ 0-Beta"));
		const beta = screen.findIndex(line => line.includes("0-Beta ➤ Main"));
		expect(alpha).toBeGreaterThan(0);
		expect(beta).toBeGreaterThan(alpha);
		expect(screen[alpha + 1]).toContain("first note");
		expect(screen.join("\n")).toContain("2 messages · 0 broadcast · 3 participants");
	});

	it("marks broadcast legs, replies and failed deliveries", () => {
		const view = mount([
			entry("0-Alpha", "0-Beta", "fan out", { broadcast: true }),
			entry("0-Beta", "0-Gone", "lost", { outcome: "failed", error: 'Unknown agent "0-Gone"' }),
		]);
		const screen = view.screen().join("\n");
		expect(screen).toMatch(/0-Alpha ➤ 0-Beta\s+broadcast/);
		expect(screen).toContain('failed: Unknown agent "0-Gone"');
	});

	it("keeps messages that no longer fit, scrolled by selection, instead of dropping them", () => {
		const many = Array.from({ length: 40 }, (_, index) => entry("0-Alpha", "0-Beta", `note ${index}`));
		const view = mount(many, 20);
		expect(view.screen().join("\n")).toContain("note 39");
		expect(view.screen().join("\n")).not.toContain("note 0");
		view.viewer.handleInput("\x1b[H"); // Home
		const top = view.screen().join("\n");
		expect(top).toContain("note 0");
		expect(top).not.toContain("note 39");
	});

	it("follows new traffic while at the newest message and re-renders on each arrival", () => {
		const view = mount(
			Array.from({ length: 30 }, (_, index) => entry("0-Alpha", "0-Beta", `old ${index}`)),
			20,
		);
		view.screen();
		const before = view.renders();
		view.push(entry("0-Gamma", "0-Alpha", "fresh arrival"));
		expect(view.renders()).toBe(before + 1);
		expect(view.screen().join("\n")).toContain("fresh arrival");
	});

	it("filters by participant on either side of the arrow", () => {
		const view = mount([
			entry("0-Alpha", "0-Beta", "alpha to beta"),
			entry("0-Gamma", "0-Delta", "gamma to delta"),
			entry("0-Delta", "0-Alpha", "delta to alpha"),
		]);
		view.type("/alpha");
		view.viewer.handleInput("\r");
		const screen = view.screen().join("\n");
		expect(screen).toContain("alpha to beta");
		expect(screen).toContain("delta to alpha");
		expect(screen).not.toContain("gamma to delta");
		expect(screen).toContain("filter: alpha");
		// Esc while editing clears the filter rather than closing the viewer.
		view.viewer.handleInput("/");
		view.viewer.handleInput("\x1b");
		expect(view.closed()).toBe(0);
		expect(view.screen().join("\n")).toContain("gamma to delta");
	});

	it("collapses long bodies and expands the selected message on Enter", () => {
		const body = Array.from({ length: 6 }, (_, index) => `line ${index}`).join("\n");
		const view = mount([entry("0-Alpha", "0-Beta", body)]);
		const collapsed = view.screen().join("\n");
		expect(collapsed).toContain("line 1");
		expect(collapsed).not.toContain("line 5");
		expect(collapsed).toContain("+4 more lines");
		view.viewer.handleInput("\r");
		expect(view.screen().join("\n")).toContain("line 5");
	});

	it("scrolls line by line through an expanded message taller than the screen before moving on", () => {
		const body = Array.from({ length: 60 }, (_, index) => `row-${index}-end`).join("\n");
		const view = mount([entry("0-Alpha", "0-Beta", body), entry("0-Beta", "0-Alpha", "next message")], 20);
		const firstRow = () => {
			const match = view
				.screen()
				.join("\n")
				.match(/row-(\d+)-end/);
			return match ? Number(match[1]) : -1;
		};
		view.viewer.handleInput("\x1b[H"); // Home
		view.viewer.handleInput("\r");
		expect(firstRow()).toBe(0);
		for (let i = 0; i < 5; i++) view.viewer.handleInput("\x1b[B");
		expect(firstRow()).toBe(4);
		view.viewer.handleInput("\x1b[A");
		expect(firstRow()).toBe(3);
		for (let i = 0; i < 100; i++) view.viewer.handleInput("\x1b[B");
		const end = view.screen().join("\n");
		expect(end).toContain("row-59-end");
		expect(end).toContain("next message");
	});

	it("closes on Esc or its own key and drops its subscription on dispose", () => {
		const view = mount([entry("0-Alpha", "0-Beta", "note")]);
		view.viewer.handleInput("\x1b");
		view.viewer.handleInput("\x1bi");
		expect(view.closed()).toBe(2);
		expect(view.listenerCount()).toBe(1);
		view.viewer.dispose();
		expect(view.listenerCount()).toBe(0);
	});

	describe("replying as the operator", () => {
		function withReply(initial: IrcLogEntry[]) {
			const sent: [string, string, string][] = [];
			const view = mount(initial, 30, {
				operatorId: "Captain",
				reply: async (to, message, replyTo) => {
					sent.push([to, message, replyTo]);
					return { text: `Delivered to ${to}.`, isError: false };
				},
			});
			return { view, sent };
		}

		it("answers the selected message's sender with its id as the reply target", async () => {
			const question = entry("0-Alpha", "Captain", "which branch?");
			const { view, sent } = withReply([question]);
			view.viewer.handleInput("r");
			expect(view.screen().join("\n")).toContain("reply to 0-Alpha:");
			view.type("nightly");
			view.viewer.handleInput("\r");
			await Bun.sleep(0);
			expect(sent).toEqual([["0-Alpha", "nightly", question.message.id]]);
			expect(view.screen().join("\n")).toContain("Delivered to 0-Alpha.");
		});

		it("answers the recipient when the selected message is her own", () => {
			const { view } = withReply([entry("Captain", "0-Beta", "status?")]);
			view.viewer.handleInput("r");
			expect(view.screen().join("\n")).toContain("reply to 0-Beta:");
		});

		it("sends nothing on Esc, and keeps r inert without a reply sink", () => {
			const { view, sent } = withReply([entry("0-Alpha", "Captain", "ping")]);
			view.viewer.handleInput("r");
			view.type("draft");
			view.viewer.handleInput("\x1b");
			expect(sent).toEqual([]);
			expect(view.closed()).toBe(0);
			const plain = mount([entry("0-Alpha", "0-Beta", "ping")]);
			plain.viewer.handleInput("r");
			expect(plain.screen().join("\n")).not.toContain("reply to");
		});
	});
});

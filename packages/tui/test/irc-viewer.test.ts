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
		insert: (index: number, next: IrcLogEntry) => {
			entries.splice(index, 0, next);
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
		expect(screen).toContain("Search: alpha");
		// Enter leaves the literal field without discarding the active query.
		view.viewer.handleInput("/");
		view.viewer.handleInput("\r");
		expect(view.closed()).toBe(0);
		expect(view.screen().join("\n")).not.toContain("gamma to delta");
		expect(view.viewer.navigationSnapshot().filter).toMatchObject({ value: "alpha", focused: false });
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

	it("shares normal motions while visual-line scroll leaves message selection unchanged", () => {
		const messages = Array.from({ length: 40 }, (_, index) => entry("Alpha", "Beta", `note ${index}`));
		const view = mount(messages, 20);
		view.screen();
		view.viewer.handleInput("g");
		view.viewer.handleInput("g");
		view.screen();
		expect(view.viewer.navigationSnapshot().selected).toBe(messages[0]!.message.id);
		view.viewer.handleInput("j");
		view.screen();
		const selected = view.viewer.navigationSnapshot().selected;
		const top = view.viewer.navigationSnapshot().top;
		view.viewer.handleInput("\x05");
		view.screen();
		expect(view.viewer.navigationSnapshot().selected).toBe(selected);
		expect(view.viewer.navigationSnapshot().top).toBe(top + 1);
		view.viewer.handleInput("\x19");
		view.screen();
		expect(view.viewer.navigationSnapshot().top).toBe(top);
		view.viewer.handleInput("\x04");
		expect(view.viewer.navigationSnapshot().selectedIndex).toBeGreaterThan(1);
		view.viewer.handleInput("\x15");
		expect(view.viewer.navigationSnapshot().selectedIndex).toBe(1);
		view.viewer.handleInput("\x1b[6~");
		expect(view.viewer.navigationSnapshot().selectedIndex).toBeGreaterThan(2);
		view.viewer.handleInput("\x1b[5~");
		expect(view.viewer.navigationSnapshot().selectedIndex).toBe(1);
		view.viewer.handleInput("G");
		expect(view.viewer.navigationSnapshot().selected).toBe(messages[39]!.message.id);
		expect(view.viewer.navigationSnapshot().follow).toBe(true);
		view.viewer.handleInput(" ");
		expect(view.viewer.navigationSnapshot().expanded).toContain(messages[39]!.message.id);
		view.viewer.dispose();
	});

	it("restores stable messages, visual scroll and literal search caret without recording a visit", () => {
		const messages = Array.from({ length: 20 }, (_, index) => entry("jkl / hg", "Main", `note ${index}`));
		const view = mount(messages, 20);
		view.screen();
		view.type("/jkl / hg");
		view.viewer.handleInput("\x1b[D");
		const field = view.viewer.navigationSnapshot().filter;
		expect(field.value).toBe("jkl / hg");
		expect(field.cursor).toBe(field.value.length - 1);
		view.viewer.handleInput("\r");
		view.viewer.handleInput("g");
		view.viewer.handleInput("g");
		view.viewer.handleInput("j");
		view.screen();
		view.viewer.handleInput("\x05");
		view.screen();
		const saved = view.viewer.navigationSnapshot();
		const restored = mount([messages[1]!, messages[0]!, ...messages.slice(2)], 20);
		const visits: string[] = [];
		restored.viewer.onNavigationVisit = page => visits.push(page);
		restored.viewer.restoreNavigation(saved);
		restored.screen();
		expect(restored.viewer.navigationSnapshot()).toMatchObject({
			selected: messages[1]!.message.id,
			selectedIndex: 0,
			top: saved.top,
			follow: false,
			filter: { ...field, focused: false },
		});
		expect(visits).toEqual([]);
		view.viewer.dispose();
		restored.viewer.dispose();
	});

	it("keeps reply draft, recipient, caret and editor focus through silent history restoration", () => {
		const message = entry("Alpha", "Captain", "question");
		const sent: string[] = [];
		const view = mount([message], 20, {
			reply: async (_to, body) => {
				sent.push(body);
				return { text: "sent", isError: false };
			},
		});
		const visits: { page: string; before: unknown }[] = [];
		view.viewer.onNavigationVisit = (page, before) => visits.push({ page, before });
		view.type("rj/k h l G /");
		view.viewer.handleInput("\x1b[D");
		const saved = view.viewer.navigationSnapshot();
		expect(saved.compose).toEqual({ to: "Alpha", replyTo: message.message.id });
		expect(saved.draft).toMatchObject({ value: "j/k h l G /", focused: true, cursor: 10 });
		expect(visits).toEqual([]);
		view.viewer.handleInput("\t");
		expect(view.viewer.navigationSnapshot().draft.focused).toBe(false);
		view.viewer.handleInput("\t");
		expect(view.viewer.navigationSnapshot().draft.focused).toBe(true);
		view.viewer.restoreNavigation(saved);
		expect(view.viewer.navigationSnapshot()).toEqual(saved);
		expect(visits).toEqual([]);
		expect(sent).toEqual([]);
		view.viewer.handleInput("\x1b");
		expect(view.viewer.navigationSnapshot().compose).toBeDefined();
		expect(view.viewer.navigationSnapshot().draft.focused).toBe(false);
		view.viewer.handleInput("\x1b");
		expect(view.viewer.navigationSnapshot().compose).toBeUndefined();
		expect(view.viewer.navigationSnapshot().draft).toEqual({ ...saved.draft, focused: false });
		expect(visits).toEqual([]);
		expect(view.closed()).toBe(0);
		expect(sent).toEqual([]);
		view.viewer.dispose();
	});

	it("blocks history only while an explicitly sent reply is in flight", async () => {
		const delivery = Promise.withResolvers<{ text: string; isError: boolean }>();
		let sends = 0;
		const view = mount([entry("Alpha", "Captain", "ping")], 20, {
			reply: () => {
				sends++;
				return delivery.promise;
			},
		});
		view.type("rdraft");
		const saved = view.viewer.navigationSnapshot();
		view.viewer.restoreNavigation(saved);
		expect(sends).toBe(0);
		expect(view.viewer.blocksMenuHistory).toBe(false);
		view.viewer.handleInput("\r");
		expect(sends).toBe(1);
		expect(view.viewer.blocksMenuHistory).toBe(true);
		delivery.resolve({ text: "sent", isError: false });
		await Bun.sleep(0);
		expect(view.viewer.blocksMenuHistory).toBe(false);
		view.viewer.dispose();
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

		it("keeps a manually selected reply target when an earlier send completes out of order", () => {
			const earlier = entry("0-Earlier", "Captain", "slow send");
			const selected = entry("0-Selected", "Captain", "selected note");
			const later = entry("0-Later", "Captain", "newer note");
			const { view, sent } = withReply([selected, later]);
			view.screen();
			view.viewer.handleInput("\x1b[H");
			view.screen();
			view.insert(0, earlier);
			// Input can arrive before the requested repaint.
			view.viewer.handleInput("r");
			view.type("answer");
			view.viewer.handleInput("\r");
			expect(sent).toEqual([["0-Selected", "answer", selected.message.id]]);
		});

		it("scrolls the expanded message when navigation arrives before repaint", () => {
			const selected = entry("0-Selected", "Captain", Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"));
			const { view, sent } = withReply([selected, entry("0-Later", "Captain", "next")]);
			view.screen();
			view.viewer.handleInput("\x1b[H");
			view.screen();
			view.viewer.handleInput("\r");
			view.viewer.handleInput("\x1b[B");
			view.viewer.handleInput("r");
			view.type("answer");
			view.viewer.handleInput("\r");
			expect(sent).toEqual([["0-Selected", "answer", selected.message.id]]);
		});

		it("keeps scrolling an expanded selection after an earlier insert before repaint", () => {
			const selected = entry("0-Selected", "Captain", Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"));
			const { view, sent } = withReply([selected, entry("0-Later", "Captain", "next")]);
			view.screen();
			view.viewer.handleInput("\x1b[H");
			view.screen();
			view.viewer.handleInput("\r");
			view.screen();
			view.viewer.handleInput("\x1b[6~");
			view.viewer.handleInput("\x1b[6~");
			view.screen();
			view.insert(0, entry("0-Earlier", "Captain", "slow send"));
			view.viewer.handleInput("\x1b[B");
			view.viewer.handleInput("r");
			view.type("answer");
			view.viewer.handleInput("\r");
			expect(sent).toEqual([["0-Selected", "answer", selected.message.id]]);
		});

		it("selects the preceding message on Up when an insert shifts the expanded viewport before repaint", () => {
			const selected = entry("0-Selected", "Captain", Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"));
			const earlier = entry("0-Earlier", "Captain", "slow send");
			const { view, sent } = withReply([selected, entry("0-Later", "Captain", "next")]);
			view.screen();
			view.viewer.handleInput("\x1b[H");
			view.screen();
			view.viewer.handleInput("\r");
			view.screen();
			view.insert(0, earlier);
			view.viewer.handleInput("\x1b[A");
			view.viewer.handleInput("r");
			view.type("answer");
			view.viewer.handleInput("\r");
			expect(sent).toEqual([["0-Earlier", "answer", earlier.message.id]]);
		});

		it("scrolls the newest expanded message when End and Up arrive before repaint", () => {
			const last = entry("0-Last", "Captain", Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"));
			const { view, sent } = withReply([entry("0-First", "Captain", "first"), last]);
			view.screen();
			view.viewer.handleInput("\r");
			view.screen();
			view.viewer.handleInput("\x1b[H");
			view.screen();
			view.viewer.handleInput("\x1b[F");
			view.viewer.handleInput("\x1b[A");
			view.viewer.handleInput("r");
			view.type("answer");
			view.viewer.handleInput("\r");
			expect(sent).toEqual([["0-Last", "answer", last.message.id]]);
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

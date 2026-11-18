import { beforeAll, describe, expect, it } from "bun:test";
import { rankSessionSearchMatches, SessionSelectorComponent } from "@oh-my-pi/pi-tui/overlays/session-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";

beforeAll(async () => {
	await initTheme();
});

function createSession(id: string, title: string | undefined, modified: string): SessionInfo {
	return {
		path: `/work/sessions/${id}.jsonl`,
		id,
		cwd: "/work",
		title,
		created: new Date(modified),
		modified: new Date(modified),
		messageCount: 2,
		size: 1,
		firstMessage: `${id} prompt`,
		allMessagesText: `${id} prompt`,
	};
}

const DOWN = "\x1b[B";
const DELETE = "\x1b[3~";

/**
 * The picker opens on preliminary rows (history.db titles) and swaps in the
 * full scan when it settles; the swap must neither move the cursor onto
 * another session nor undo edits made while the scan ran.
 */
describe("SessionSelectorComponent complete listing", () => {
	it("swaps in the complete listing without moving the cursor off the selected session", async () => {
		const alpha = createSession("alpha", "Alpha", "2024-01-03T00:00:00Z");
		const beta = createSession("beta", "Beta", "2024-01-02T00:00:00Z");
		const complete = Promise.withResolvers<SessionInfo[]>();
		const selected: SessionInfo[] = [];
		const selector = new SessionSelectorComponent(
			[alpha, beta],
			session => selected.push(session),
			() => {},
			() => {},
			{ completeSessions: complete.promise },
		);
		selector.handleInput(DOWN);

		// The full scan adds an untitled session above the cursor.
		complete.resolve([
			createSession("fresh", undefined, "2024-01-04T00:00:00Z"),
			createSession("alpha", "Alpha", "2024-01-03T00:00:00Z"),
			createSession("beta", "Beta", "2024-01-02T00:00:00Z"),
		]);
		// The picker subscribed first, so its swap has run once this await resumes.
		await complete.promise;

		expect(selector.render(120).join("\n")).toContain("fresh prompt");
		selector.handleInput("\n");
		expect(selected.map(session => session.id)).toEqual(["beta"]);
	});

	it("keeps a session deleted before the complete listing landed out of it", async () => {
		const complete = Promise.withResolvers<SessionInfo[]>();
		const selector = new SessionSelectorComponent(
			[
				createSession("alpha", "Alpha", "2024-01-03T00:00:00Z"),
				createSession("beta", "Beta", "2024-01-02T00:00:00Z"),
			],
			() => {},
			() => {},
			() => {},
			{ completeSessions: complete.promise, onDelete: async () => true },
		);
		selector.handleInput(DELETE);
		selector.handleInput("\n");
		// Flush the confirmed delete's async chain, as the delete tests do.
		await Bun.sleep(0);

		// Scanned before the delete, so the listing still holds the session.
		complete.resolve([
			createSession("alpha", "Alpha", "2024-01-03T00:00:00Z"),
			createSession("beta", "Beta", "2024-01-02T00:00:00Z"),
		]);
		await complete.promise;

		const rendered = selector.render(120).join("\n");
		expect(rendered).not.toContain("Alpha");
		expect(rendered).toContain("Beta");
	});

	it("keeps renamed titles searchable through cached regex rows and a stale complete scan", async () => {
		const alpha = createSession("alpha", "Old title", "2024-01-03T00:00:00Z");
		const scanned = createSession("alpha", "Old title", "2024-01-03T00:00:00Z");
		rankSessionSearchMatches([scanned], "/Old title/");
		const complete = Promise.withResolvers<SessionInfo[]>();
		const selected: SessionInfo[] = [];
		const selector = new SessionSelectorComponent(
			[alpha],
			session => selected.push(session),
			() => {},
			() => {},
			{ completeSessions: complete.promise, onRename: async () => "New title" },
		);
		try {
			selector.handleInput("/");
			selector.handleInput("/Old title/");
			selector.handleInput("\n");
			selector.getSessionList().describeList();
			selector.getSessionList().requestRename();
			selector.handleInput("\x15");
			selector.handleInput("New title");
			selector.handleInput("\n");
			await Bun.sleep(0);
			selector.getSessionList().clearSearch();
			expect(JSON.stringify(selector.getSessionList().describeList())).not.toContain("Old title");

			complete.resolve([scanned]);
			await complete.promise;
			expect(Bun.stripANSI(selector.render(120).join("\n"))).toContain("New title");
			selector.handleInput("/");
			selector.handleInput("/New title/");
			selector.handleInput("\n");
			selector.handleInput("\n");
			expect(selected.map(session => ({ id: session.id, title: session.title }))).toEqual([
				{ id: "alpha", title: "New title" },
			]);
		} finally {
			selector.dispose();
		}
	});
});

import { beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentsSection } from "@oh-my-pi/pi-coding-agent/modes/side-panel/agents-section";
import { cfgSidebarAgentOrder } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { parseSgrMouse, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
import { SidePanel } from "@oh-my-pi/pi-tui/chrome";
import type { AgentRecordLike } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import type { ObservableSession } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

function ref(id: string, overrides: Partial<AgentRecordLike> = {}): AgentRecordLike {
	return {
		id,
		displayName: id,
		kind: "sub",
		status: "running",
		session: null,
		sessionFile: null,
		createdAt: 0,
		lastActivity: 0,
		...overrides,
	};
}

function event(report: string): SgrMouseEvent {
	const parsed = parseSgrMouse(report);
	if (!parsed) throw new Error("bad report");
	return parsed;
}

const leftClick = event("\x1b[<0;2;1M");
const motion = event("\x1b[<35;2;1M");

/** An Agents section in a real SidePanel, with the host's calls recorded. */
function harness(
	agents: AgentRecordLike[],
	sessions = new Map<string, ObservableSession>(),
	settings = Settings.isolated(),
) {
	const calls: string[] = [];
	let focused: string | undefined;
	let renders = 0;
	const section = new AgentsSection({
		settings,
		observed: id => sessions.get(id),
		visible: () => false,
		agents: () => agents,
		focusedAgentId: () => focused,
		focus: id => {
			calls.push(`focus ${id}`);
			focused = id;
		},
		returnToPrimary: () => {
			calls.push("primary");
			focused = undefined;
		},
		requestRender: () => {
			renders++;
		},
		onChange: () => () => {},
	});
	const panel = new SidePanel({ onEmptyClick: () => section.clickEmpty() });
	panel.register(section);
	panel.setHeight(10);
	const render = () => panel.render(40).map(line => Bun.stripANSI(line));
	render();
	return { panel, calls, render, section, settings, renders: () => renders };
}

beforeAll(async () => {
	await initTheme();
});

describe("AgentsSection", () => {
	it("lists subagents and read-only advisors in spawn order, whatever their status, and nothing else", () => {
		const agents = [
			ref("Runner", { createdAt: 2 }),
			ref("Parked", { status: "parked", createdAt: 1 }),
			ref("Advisor", { kind: "advisor", status: "idle", createdAt: 3 }),
			ref("Main", { kind: "main" }),
			ref("Operator", { kind: "operator" }),
		];
		const h = harness(agents);
		const order = () => {
			const rows = h.render();
			return ["Parked", "Runner", "Advisor"].map(id => rows.findIndex(row => row.includes(id)));
		};
		expect(order()).toEqual([1, 2, 3]);
		expect(h.render()[3]).toContain("read-only");
		expect(h.render().some(row => row.includes("Main") || row.includes("Operator"))).toBe(false);
		// Reviving the parked agent does not move its row under the pointer.
		agents[1] = ref("Parked", { status: "running", createdAt: 1 });
		expect(order()).toEqual([1, 2, 3]);
	});

	it("shows the agent clicked in the main area and returns to the primary on a second click or empty space", () => {
		const h = harness([ref("Runner"), ref("Other", { createdAt: 1 })]);
		// Row 0 is the title; agent rows follow in order.
		h.panel.routeMouse(leftClick, 1, 2);
		expect(h.calls).toEqual(["focus Runner"]);
		h.panel.routeMouse(leftClick, 1, 2);
		expect(h.calls).toEqual(["focus Runner", "primary"]);
		h.panel.routeMouse(leftClick, 2, 2);
		h.render();
		// Far below the document is empty panel space.
		h.panel.routeMouse(leftClick, 9, 2);
		expect(h.calls).toEqual(["focus Runner", "primary", "focus Other", "primary"]);
		// Empty space while the primary is shown does nothing.
		h.panel.routeMouse(leftClick, 9, 2);
		expect(h.calls).toHaveLength(4);
	});

	it("repaints only when the hovered row changes and drops the hover when the pointer leaves", () => {
		const h = harness([ref("Runner")]);
		const before = h.renders();
		h.panel.routeMouse(motion, 1, 2);
		h.panel.routeMouse(motion, 1, 3);
		expect(h.renders()).toBe(before + 1);
		h.panel.pointerLeave();
		expect(h.renders()).toBe(before + 2);
		h.panel.pointerLeave();
		expect(h.renders()).toBe(before + 2);
	});

	it("renders nothing without agents, so the panel shows its placeholder", () => {
		const h = harness([]);
		expect(h.render()[0]).toContain("nothing to show");
	});
});

describe("live Agents panel", () => {
	it("keeps independent bottom filters and autoscroll when reopened, with only running subagents initially", () => {
		const agents = [
			ref("Runner"),
			ref("Parked", { status: "parked" }),
			ref("Idler", { status: "idle" }),
			ref("Advisor", { kind: "advisor", status: "running" }),
		];
		const h = harness(agents);
		h.panel.setHeight(20);
		const click = (label: string) => {
			const lines = h.render();
			const row = lines.findIndex(line => line.includes(label));
			expect(row).toBe(19);
			h.panel.routeMouse(leftClick, row, lines[row]!.indexOf(label));
		};
		expect(h.render().join("\n")).toContain("Runner");
		expect(h.render().join("\n")).not.toMatch(/Parked|Advisor|Idler/);
		click("-Park");
		click("-Adv");
		click("+Run");
		click("+Auto");
		const reopened = harness(agents, undefined, h.settings);
		reopened.panel.setHeight(20);
		expect(reopened.render().join("\n")).toMatch(/Parked[\s\S]+Advisor/);
		expect(reopened.render().join("\n")).not.toMatch(/Runner|Idler/);
		expect(reopened.render()[19]).toContain("-Auto");
	});

	it("keeps the latest parked agent at the head of its group and follows an agent revived later", () => {
		const agents = [
			ref("Runner", { createdAt: 1 }),
			ref("OldPark", { status: "parked", lastActivity: 3 }),
			ref("NewPark", { status: "parked", lastActivity: 4 }),
		];
		const h = harness(agents, undefined, Settings.isolated({ "sidebar.agents.filters": ["running", "parked"] }));
		h.panel.setHeight(20);
		expect(h.render().join("\n")).toMatch(/NewPark[\s\S]+OldPark[\s\S]+Runner/);
		agents[1] = ref("OldPark", { createdAt: 0, lastActivity: 5 });
		expect(h.render().join("\n")).toMatch(/NewPark[\s\S]+Runner[\s\S]+OldPark/);
		agents.push(ref("Fresh", { createdAt: 6, lastActivity: 6 }));
		h.panel.setHeight(6);
		expect(h.render().join("\n")).toContain("Fresh");
		expect(h.render().join("\n")).not.toContain("NewPark");
		cfgSidebarAgentOrder.set(h.settings, "newest-at-top");
		h.panel.setHeight(20);
		expect(h.render().join("\n")).toMatch(/Fresh[\s\S]+OldPark[\s\S]+Runner[\s\S]+NewPark/);
	});

	it("shows the observed model, assignment, elapsed units, and only a current wait timer", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(20_000);
		try {
			const session: ObservableSession = {
				id: "Runner",
				kind: "subagent",
				label: "Runner",
				status: "active",
				lastUpdate: 20_000,
				progressAt: 20_000,
				progress: {
					index: 0,
					id: "Runner",
					agent: "task",
					agentSource: "bundled",
					status: "running",
					task: "prompt",
					assignment: "Inspect roster",
					resolvedModel: "local/roster-model",
					currentTool: "wait",
					currentToolIntent: "Waiting on reports",
					currentToolStartMs: 19_500,
					durationMs: 20_000,
					recentTools: [],
					recentOutput: [],
					toolCount: 1,
					requests: 1,
					tokens: 0,
					cost: 0,
				},
			};
			const h = harness([ref("Runner")], new Map([["Runner", session]]));
			const screen = () => h.render().join("\n");
			expect(screen()).toMatch(
				/Runner roster-model[\s\S]+20s Inspect roster[\s\S]+Waiting on reports[\s\S]+wait 500ms/,
			);
			now.mockReturnValue(62_000);
			expect(screen()).toContain("1:02 Inspect roster");
			now.mockReturnValue(3_662_000);
			expect(screen()).toContain("1:01:02 Inspect roster");
			session.progress!.currentTool = undefined;
			session.progress!.lastIntent = "Reviewing reports";
			expect(screen()).toContain("Reviewing reports");
			expect(screen()).not.toContain("wait ");
		} finally {
			now.mockRestore();
		}
	});
});

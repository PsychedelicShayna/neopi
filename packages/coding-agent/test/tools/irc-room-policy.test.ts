import { afterEach, expect, it, vi } from "bun:test";
import type { IrcSend, IrcSendOptions } from "../../src/irc/bus";
import { IrcGroups, type IrcGroupSnapshot, type IrcInviteNoticeMode } from "../../src/irc/groups";
import { AgentRegistry } from "../../src/registry/agent-registry";

const group = "council";

afterEach(() => {
	vi.useRealTimers();
});

function fixture() {
	const registry = new AgentRegistry();
	const root = registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
	for (const id of ["Operator", "Creator", "Reader", "Guest", "New", "Quiet", "Unreachable"]) {
		registry.register({
			id,
			displayName: id,
			kind: id === "Operator" ? "operator" : "sub",
			parentId: root.id,
			session: null,
		});
	}
	registry.register({ id: "OtherRoot", displayName: "OtherRoot", kind: "main", session: null });
	const legs: { message: IrcSend; options?: IrcSendOptions }[] = [];
	const notices: { to: string; mode: IrcInviteNoticeMode; persisted: boolean }[] = [];
	let saved: IrcGroupSnapshot | undefined;
	let current = true;
	return {
		legs,
		notices,
		invalidate: () => {
			current = false;
		},
		open() {
			const groups = new IrcGroups(
				registry,
				{
					async send(message, options) {
						legs.push({ message, options });
						return { to: message.to, outcome: "injected" };
					},
				},
				saved,
				{
					isCurrent: () => current,
					save: snapshot => {
						saved = structuredClone(snapshot);
					},
				},
				{
					includes: ref => registry.rootOf(ref.id) === root,
					async deliverInvite(_from, to, name, mode) {
						const persisted = saved?.groups.find(room => room.name === name)?.members.includes(to) ?? false;
						notices.push({ to, mode, persisted });
						if (to === "Unreachable") return { to, outcome: "failed", error: "unreachable" };
						return { to, outcome: "queued" };
					},
				},
			);
			if (saved) groups.restore(saved, undefined);
			return groups;
		},
	};
}

it("restricts the actor and all mutation and fanout targets to the current session", async () => {
	const setup = fixture();
	const rooms = setup.open();
	try {
		expect(await rooms.execute("OtherRoot", { op: "groups" })).toMatchObject({ isError: true });
		expect(rooms.snapshot("OtherRoot")).toEqual([]);
		expect((await rooms.execute("Main", { op: "members", group: "everyone" })).members).not.toContain("OtherRoot");
		expect(await rooms.execute("Main", { op: "create", group, members: ["Creator", "OtherRoot"] })).toMatchObject({
			isError: true,
		});
		expect((await rooms.execute("Main", { op: "groups" })).groups).toEqual(["everyone"]);
		await rooms.execute("Creator", { op: "create", group, members: ["Creator", "Reader"], notice: "silent" });
		expect(await rooms.execute("Guest", { op: "send", group, message: "outside" })).toMatchObject({
			isError: true,
			text: expect.stringContaining("Join"),
		});
		expect(await rooms.execute("Main", { op: "remove", group, members: ["Reader", "OtherRoot"] })).toMatchObject({
			isError: true,
		});
		expect((await rooms.execute("Main", { op: "members", group })).members).toEqual(["Creator", "Reader"]);
		expect(rooms.filterBroadcastTargets("Reader", ["Creator", "Reader", "OtherRoot"])).toEqual(["Creator", "Reader"]);
		await rooms.execute("Main", { op: "permit", group: "everyone", members: ["Reader"], permissions: { send: false } });
		expect(rooms.filterBroadcastTargets("Reader", ["Creator"])).toEqual([]);
		expect(await rooms.execute("Reader", { op: "send", group: "everyone", message: "blocked broadcast" })).toMatchObject({
			isError: true,
			text: expect.stringContaining("Send permission"),
		});
		setup.invalidate();
		expect(await rooms.execute("Creator", { op: "send", group, message: "stale" })).toMatchObject({ isError: true });
		expect(setup.legs).toEqual([]);
	} finally {
		rooms.dispose();
	}
});

it("attenuates invitations and keeps denied rights on open self-rejoin", async () => {
	const setup = fixture();
	const rooms = setup.open();
	try {
		await rooms.execute("Creator", { op: "create", group, members: ["Creator", "Reader"], notice: "silent" });
		await rooms.execute("Main", { op: "permit", group, members: ["Reader"], permissions: { send: false } });
		expect(await rooms.execute("Reader", { op: "send", group, message: "blocked" })).toMatchObject({
			isError: true,
			text: expect.stringContaining("Send permission"),
		});
		expect(await rooms.execute("Creator", { op: "send", group, message: "reader still hears" })).toMatchObject({
			receipts: [{ to: "Creator" }, { to: "Reader" }],
		});
		expect(await rooms.execute("Reader", { op: "add", group, members: ["Guest"] })).toMatchObject({
			isError: true,
			text: expect.stringContaining("send"),
		});
		expect(
			await rooms.execute("Reader", { op: "add", group, members: ["Guest"], permissions: { admin: true } }),
		).toMatchObject({ isError: true, text: expect.stringContaining("admin") });
		expect(
			await rooms.execute("Reader", {
				op: "invite",
				group,
				members: ["Guest"],
				permissions: { send: false },
				notice: "silent",
			}),
		).toMatchObject({ affected: ["Guest"] });
		expect(await rooms.execute("Reader", { op: "remove", group, members: ["Guest"] })).toMatchObject({
			isError: true,
			text: expect.stringContaining("Admin permission"),
		});
		expect(await rooms.execute("Reader", { op: "mute", group, member: "Guest" })).toMatchObject({
			isError: true,
			text: expect.stringContaining("Admin permission"),
		});
		await rooms.execute("Creator", { op: "permit", group, members: ["Guest"], permissions: { receive: false } });
		await rooms.execute("Guest", { op: "leave", group });
		expect(
			await rooms.execute("Guest", { op: "add", group, members: ["Guest"], permissions: { send: true } }),
		).toMatchObject({ isError: true });
		await rooms.execute("Guest", { op: "add", group, members: ["Guest"], notice: "silent" });
		expect(await rooms.execute("Guest", { op: "members", group })).toMatchObject({
			room: { joined: true, permissions: { receive: false, send: false, invite: true, admin: false } },
		});
		const sent = await rooms.execute("Creator", { op: "send", group, message: "deaf member is excluded" });
		expect(sent.receipts?.map(item => item.to)).toEqual(["Creator", "Reader"]);
		await rooms.execute("Creator", { op: "permit", group, members: ["Reader"], permissions: { admin: true } });
		expect(await rooms.execute("Reader", { op: "members", group })).toMatchObject({
			room: { permissions: { receive: true, send: true, invite: true, admin: true } },
		});
		expect(await rooms.execute("Reader", { op: "remove", group, members: ["Guest"] })).toMatchObject({
			affected: ["Guest"],
		});
	} finally {
		rooms.dispose();
	}
});

it("persists policy, keeps operator mutes on rejoin, and publishes expiry without another command", async () => {
	vi.useFakeTimers();
	const setup = fixture();
	let rooms = setup.open();
	try {
		await rooms.execute("Creator", { op: "create", group, members: ["Creator", "Reader"], notice: "silent" });
		await rooms.execute("Operator", { op: "permit", group, members: ["Reader"], permissions: { invite: false } });
		await rooms.execute("Reader", { op: "mute", group });
		expect(await rooms.execute("Reader", { op: "send", group, message: "blocked" })).toMatchObject({
			isError: true,
			text: expect.stringContaining("Unmute first"),
		});
		expect(await rooms.execute("Creator", { op: "unmute", group, member: "Reader" })).toMatchObject({
			affected: ["Reader"],
		});
		expect(await rooms.execute("Creator", { op: "mute", group, member: "Reader" })).toMatchObject({
			affected: ["Reader"],
		});
		expect(await rooms.execute("Reader", { op: "unmute", group })).toMatchObject({
			isError: true,
			text: expect.stringContaining("Creator"),
		});
		await rooms.execute("Operator", { op: "mute", group, member: "Reader", duration: "30m" });
		await rooms.execute("Reader", { op: "leave", group });
		await rooms.execute("Reader", { op: "add", group, members: ["Reader"], notice: "silent" });
		vi.advanceTimersByTime(10 * 60_000);
		rooms.dispose();
		rooms = setup.open();
		expect(await rooms.execute("Reader", { op: "members", group })).toMatchObject({
			text: expect.stringContaining("20m left"),
			room: { permissions: { invite: false }, mute: { authority: "operator", by: "Operator" } },
		});
		expect(await rooms.execute("Reader", { op: "unmute", group })).toMatchObject({
			isError: true,
			text: expect.stringContaining("direct message"),
		});
		expect(await rooms.execute("Main", { op: "mute", group, member: "Reader", duration: "1m" })).toMatchObject({
			isError: true,
		});
		const muted = await rooms.execute("Creator", { op: "send", group, message: "@Reader blocked" });
		expect(muted.receipts?.map(item => item.to)).toEqual(["Creator"]);
		const changes = vi.fn();
		const unsubscribe = rooms.onChange(changes);
		vi.advanceTimersByTime(20 * 60_000);
		expect(changes).toHaveBeenCalledTimes(1);
		expect((await rooms.execute("Reader", { op: "members", group })).room?.mute).toBeUndefined();
		const unmuted = await rooms.execute("Creator", { op: "send", group, message: "Reader hears again" });
		expect(unmuted.receipts?.map(item => item.to)).toEqual(["Creator", "Reader"]);
		await rooms.execute("Operator", { op: "mute", group, member: "Reader" });
		expect(await rooms.execute("Operator", { op: "unmute", group, member: "Reader" })).toMatchObject({
			affected: ["Reader"],
		});
		unsubscribe();
	} finally {
		rooms.dispose();
	}
});

it("distinguishes spy, silent, invisible and announced operator entry", async () => {
	const setup = fixture();
	let rooms = setup.open();
	try {
		await rooms.execute("Creator", { op: "create", group, members: ["Creator", "Reader"], notice: "silent" });
		expect(await rooms.execute("Reader", { op: "join", group, mode: "invisible" })).toMatchObject({ isError: true });
		expect(await rooms.execute("Operator", { op: "send", group, message: "spy" })).toMatchObject({ isError: true });
		expect(rooms.snapshot("Operator").find(room => room.name === group)?.joined).toBe(false);
		await rooms.execute("Operator", { op: "join", group, mode: "silent" });
		expect((await rooms.execute("Reader", { op: "members", group })).members).toContain("Operator");
		await rooms.execute("Operator", { op: "leave", group });
		await rooms.execute("Operator", { op: "join", group, mode: "invisible" });
		expect(setup.legs).toEqual([]);
		rooms.dispose();
		rooms = setup.open();
		expect((await rooms.execute("Reader", { op: "members", group })).members).toEqual(["Creator", "Reader"]);
		expect(rooms.snapshot("Operator").find(room => room.name === group)).toMatchObject({
			joined: true,
			joinMode: "invisible",
		});
		expect(rooms.shared("Reader", "Operator")).toEqual([]);
		const sent = await rooms.execute("Reader", { op: "send", group, message: "invisible delivery" });
		expect(setup.legs.map(leg => leg.message.to)).toEqual(["Creator", "Reader", "Operator"]);
		expect(sent.receipts?.map(item => item.to)).toEqual(["Creator", "Reader"]);
		expect(await rooms.execute("Operator", { op: "send", group, message: "still able to write" })).toMatchObject({
			isError: false,
		});
		setup.legs.length = 0;
		await rooms.execute("Operator", { op: "join", group, mode: "announce" });
		expect((await rooms.execute("Reader", { op: "members", group })).members).toContain("Operator");
		expect(setup.legs.map(leg => leg.options?.noWake)).toEqual([true, true, true]);
		expect(new Set(setup.legs.map(leg => leg.message.groupText))).toEqual(new Set(["Operator joined #council."]));
		expect(new Set(setup.legs.map(leg => leg.message.fanoutId)).size).toBe(1);
	} finally {
		rooms.dispose();
	}
});

it("commits invitations before notifying and reports delivery failure without reverting membership", async () => {
	const setup = fixture();
	const rooms = setup.open();
	try {
		await rooms.execute("Operator", { op: "create", group, members: ["Operator"], notice: "silent" });
		expect(setup.legs).toEqual([]); // Even the singleton reminder is silent for this action.
		await rooms.execute("Operator", { op: "invite", group, members: ["Reader"] });
		await rooms.execute("Operator", { op: "invite", group, members: ["Guest"], notice: "wake-now" });
		await rooms.execute("Operator", { op: "invite", group, members: ["New"], notice: "verbose" });
		await rooms.execute("Operator", { op: "invite", group, members: ["Quiet"], notice: "silent" });
		const partial = await rooms.execute("Operator", { op: "invite", group, members: ["Unreachable", "Quiet"] });
		expect(setup.notices).toEqual([
			{ to: "Reader", mode: "next-turn", persisted: true },
			{ to: "Guest", mode: "wake-now", persisted: true },
			{ to: "New", mode: "verbose", persisted: true },
			{ to: "Unreachable", mode: "next-turn", persisted: true },
		]);
		expect(partial).toMatchObject({ affected: ["Unreachable"], receipts: [{ to: "Unreachable", outcome: "failed" }] });
		expect((await rooms.execute("Operator", { op: "members", group })).members).toContain("Unreachable");
	} finally {
		rooms.dispose();
	}
});

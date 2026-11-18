import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { countSessionMessages } from "@oh-my-pi/pi-natives";
import { countSessionCatalogMessages } from "../src/cli/session-catalog-count";
import {
	listSessionCatalog,
	readSessionCatalog,
	type SessionCatalogExit,
	type SessionCatalogMessage,
} from "../src/cli/sessions-cli";
import { publishControlEndpoint } from "../src/control/registry";
import type { ControlSnapshot } from "../src/control/types";
import { loadSessionMessagesReadOnly } from "../src/session/session-loader";
import { sessionDirForCwd } from "../src/session/session-paths";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "npi-catalog-"));
	roots.push(root);
	const cwd = path.join(root, "project");
	await fs.mkdir(cwd);
	return {
		root,
		cwd,
		sessionsRoot: path.join(root, "sessions"),
		agentDir: path.join(root, "agent"),
		controlRegistry: { dir: path.join(root, "control") },
	};
}
async function session(
	dir: string,
	id: string,
	cwd: string,
	content: object[] = [{ role: "user", content: "hello", timestamp: 1_780_000_000_000 }],
) {
	const file = path.join(dir, `${id}.jsonl`);
	const entries = [
		{ type: "session", version: 3, id, cwd, timestamp: "2026-06-01T00:00:00.000Z" },
		...content.map((message, index) => ({
			type: "message",
			id: `m${index}`,
			parentId: index ? `m${index - 1}` : null,
			timestamp: "2026-06-01T00:00:00.000Z",
			message,
		})),
	];
	await Bun.write(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

describe("read-only session catalog", () => {
	test("project, explicit directory and all scopes share picker filtering without repairing files", async () => {
		const f = await fixture();
		await session(sessionDirForCwd(f.cwd, f.sessionsRoot), "local", f.cwd);
		await session(sessionDirForCwd(path.join(f.root, "other"), f.sessionsRoot), "other", "/other");
		const isolated = path.join(f.root, "isolated");
		await session(isolated, "isolated", f.cwd);
		await session(isolated, "empty", f.cwd, []);
		await session(isolated, "pinned", f.cwd, []);
		await Bun.write(path.join(f.agentDir, "session-pins.json"), JSON.stringify(["pinned"]));
		await Bun.write(path.join(isolated, "broken.jsonl.bak"), "do not recover me");
		const before = (await fs.readdir(isolated)).sort();
		expect((await listSessionCatalog(f)).sessions.map(s => s.id)).toEqual(["local"]);
		expect((await listSessionCatalog({ ...f, all: true })).sessions.map(s => s.id).sort()).toEqual([
			"local",
			"other",
		]);
		expect(
			(await listSessionCatalog({ ...f, sessionDirs: [isolated, isolated] })).sessions.map(s => s.id).sort(),
		).toEqual(["isolated", "pinned"]);
		expect((await fs.readdir(isolated)).sort()).toEqual(before);
		const nonexistent = path.join(f.root, "missing");
		expect((await listSessionCatalog({ ...f, sessionDirs: [nonexistent] })).sessions).toEqual([]);
		expect(await Bun.file(nonexistent).exists()).toBe(false);
	});

	test("lists missing and malformed creation timestamps alongside valid sessions", async () => {
		const f = await fixture();
		const dir = sessionDirForCwd(f.cwd, f.sessionsRoot);
		await session(dir, "valid", f.cwd);
		for (const timestamp of [undefined, "not-a-date"]) {
			const id = timestamp === undefined ? "missing" : "malformed";
			const file = await session(dir, id, f.cwd);
			const lines = (await Bun.file(file).text()).trim().split("\n");
			const header = JSON.parse(lines[0]) as Record<string, unknown>;
			header.timestamp = timestamp;
			lines[0] = JSON.stringify(header);
			await Bun.write(file, `${lines.join("\n")}\n`);
		}
		const rows = (await listSessionCatalog(f)).sessions;
		expect(rows.map(row => row.id).sort()).toEqual(["malformed", "missing", "valid"]);
		for (const row of rows) {
			expect(row.created).toBe(row.id === "valid" ? "2026-06-01T00:00:00.000Z" : row.modified);
			expect(Number.isFinite(Date.parse(row.created!))).toBe(true);
		}
	});

	test("counts the complete journal beyond a large header without changing it", async () => {
		const f = await fixture();
		const file = await session(sessionDirForCwd(f.cwd, f.sessionsRoot), "large-header", f.cwd, [
			{ role: "user", content: "GUI question" },
			{ role: "assistant", content: "GUI answer" },
			{ role: "user", content: "terminal question" },
			{ role: "assistant", content: "terminal answer" },
			{ role: "user", content: "restored question" },
			{ role: "assistant", content: "restored answer" },
		]);
		const records = (await Bun.file(file).text()).trim().split("\n");
		records[0] = JSON.stringify({
			...JSON.parse(records[0]),
			systemPrompt: "context".repeat(2_000),
		});
		const before = `${records.join("\n")}\n`;
		await Bun.write(file, before);

		const listed = await listSessionCatalog(f);
		expect(listed.sessions.map(row => ({ id: row.id, count: row.messageCount }))).toEqual([
			{ id: "large-header", count: 6 },
		]);
		expect(await Bun.file(file).text()).toBe(before);
	});

	test("does not mistake a prefix count for the complete persisted message count", async () => {
		const f = await fixture();
		await session(sessionDirForCwd(f.cwd, f.sessionsRoot), "long-message", f.cwd, [
			{ role: "user", content: "long question ".repeat(500_000) },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }],
			},
			{ role: "toolResult", content: [{ type: "text", text: "file content" }] },
			{ role: "assistant", content: "answer" },
		]);

		const listed = await listSessionCatalog(f);
		expect(listed.sessions.map(row => ({ id: row.id, count: row.messageCount }))).toEqual([
			{ id: "long-message", count: 4 },
		]);
	});

	test("counts messages across branches but skips malformed and non-message records", async () => {
		const f = await fixture();
		const file = await session(sessionDirForCwd(f.cwd, f.sessionsRoot), "branched", f.cwd, [
			{ role: "user", content: "question" },
			{ role: "assistant", content: "original answer" },
		]);
		const before = [
			(await Bun.file(file).text()).trimEnd(),
			"{broken",
			"null",
			JSON.stringify({ type: "message", id: "missing-message" }),
			JSON.stringify({ type: "custom", data: { type: "message", message: { role: "user" } } }),
			JSON.stringify({
				type: "message",
				id: "alternate",
				parentId: "m0",
				message: { role: "assistant", content: "alternate answer" },
			}),
			JSON.stringify({ type: "compaction", id: "compact", parentId: "m1", summary: "summary" }),
			JSON.stringify({
				type: "message",
				id: "latest",
				parentId: "compact",
				message: { role: "user", content: "after compaction" },
			}),
		].join("\n");
		await Bun.write(file, before);
		expect(await countSessionCatalogMessages(file, path.join(f.root, "count-cache"))).toBe(4);
		expect(await Bun.file(file).text()).toBe(before);
	});

	test("counts reordered and escaped fields but rejects invalid message records", async () => {
		const f = await fixture();
		const file = path.join(f.root, "records.jsonl");
		await Bun.write(
			file,
			[
				' { "message": {"role":"user"}, "type": "message" } ',
				'{"ty\\u0070e":"messa\\u0067e","mess\\u0061ge":{"role":"assistant"}}',
				'{"type":"ignored","type":"message","message":{}}',
				'{"type":"message","message":null,"message":{}}',
				'{"type":"message","type":"ignored","message":{}}',
				'{"type":"message","message":{},"message":null}',
				'{"type":"message","message":[]}',
				'{"type":"custom","data":{"type":"message","message":{}}}',
				JSON.stringify('{"type":"message","message":{}}'),
				'{"type":"message","message":{"content":tru}}',
				'{"type":"message","message":{"content":[1,]}}',
				'{"type":"message","message":{}} trailing',
				'{"type":"message","message":{"content":"truncated',
			].join("\r\n"),
		);
		expect(await countSessionCatalogMessages(file, path.join(f.root, "count-cache"))).toBe(4);
	});

	test("limits counting to the captured file size without counting a partial last record", async () => {
		const f = await fixture();
		const file = path.join(f.root, "growing.jsonl");
		const first = '{"type":"message","message":{"role":"user","content":"question"}}\n';
		const second = '{"type":"message","message":{"role":"assistant","content":"answer"}}';
		await Bun.write(file, first + second);
		expect(await countSessionMessages(file, first.length)).toBe(1);
		expect(await countSessionMessages(file, first.length + second.length - 1)).toBe(1);
		expect(await countSessionMessages(file, first.length + second.length)).toBe(2);
	});

	test("invalidates cached counts after appends and same-size rewrites", async () => {
		const f = await fixture();
		const file = await session(sessionDirForCwd(f.cwd, f.sessionsRoot), "cached", f.cwd);
		const cache = path.join(f.root, "count-cache");
		expect(await countSessionCatalogMessages(file, cache)).toBe(1);
		await fs.appendFile(
			file,
			`${JSON.stringify({
				type: "message",
				id: "reply",
				parentId: "m0",
				message: { role: "assistant", content: "answer" },
			})}\n`,
		);
		expect(await countSessionCatalogMessages(file, cache)).toBe(2);

		const before = await fs.stat(file);
		const rewritten = (await Bun.file(file).text()).replaceAll('"type":"message"', '"type":"ignored"');
		await Bun.write(file, rewritten);
		await fs.utimes(file, before.atime, new Date(before.mtimeMs + 2_000));
		expect((await fs.stat(file)).size).toBe(before.size);
		expect(await countSessionCatalogMessages(file, cache)).toBe(0);
	});

	test("ignores corrupt or unavailable count caches without changing the journal", async () => {
		const f = await fixture();
		const file = await session(sessionDirForCwd(f.cwd, f.sessionsRoot), "cache-fallback", f.cwd);
		const before = await Bun.file(file).text();
		const cache = path.join(f.root, "count-cache");
		expect(await countSessionCatalogMessages(file, cache)).toBe(1);
		for (const name of await fs.readdir(cache)) await Bun.write(path.join(cache, name), "{broken");
		expect(await countSessionCatalogMessages(file, cache)).toBe(1);
		const unavailable = path.join(f.root, "not-a-directory");
		await Bun.write(unavailable, "occupied");
		expect(await countSessionCatalogMessages(file, unavailable)).toBe(1);
		expect(await Bun.file(file).text()).toBe(before);
	});

	test("reports a live external lease and matches control publication through a realpath alias", async () => {
		const f = await fixture();
		const dir = path.join(f.root, "isolated");
		const file = await session(dir, "busy", f.cwd);
		const alias = path.join(f.root, "alias");
		await fs.symlink(dir, alias);
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { acquireSessionLease } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/session/session-lease.ts"))}; const lease = acquireSessionLease(process.argv[1]); process.stdout.write("ready\\n"); await Bun.stdin.text(); lease.release();`,
				file,
			],
			{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		const reader = child.stdout.getReader();
		let publication;
		try {
			expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
			publication = await publishControlEndpoint({
				dir: f.controlRegistry.dir,
				role: "tui",
				instanceId: "abcdef0123456789",
				imageId: "test",
				execPath: process.execPath,
				gitSha: null,
				profile: null,
				sessionId: "busy",
				sessionFile: path.join(alias, "busy.jsonl"),
				title: null,
				cwd: f.cwd,
				tmuxPane: null,
				tmuxSession: null,
				tmuxWindow: null,
				tty: null,
				onConnection: socket => socket.destroy(),
			});
			const listed = (await listSessionCatalog({ ...f, sessionDirs: [dir] })).sessions;
			expect(listed[0]?.inUse).toEqual({ pid: child.pid });
			expect(listed[0]?.control).toEqual({ instanceId: "abcdef0123456789", role: "tui", pid: process.pid });
			// Reading the transcript does not compete for or release the owner's lease.
			expect((await readSessionCatalog(file)).messages).toHaveLength(1);
			expect((await listSessionCatalog({ ...f, sessionDirs: [dir] })).sessions[0]?.inUse).toEqual({
				pid: child.pid,
			});
		} finally {
			reader.releaseLock();
			child.stdin.end();
			await child.exited;
			await publication?.close();
		}
		expect((await listSessionCatalog({ ...f, sessionDirs: [dir] })).sessions[0]?.inUse).toBeNull();
		expect((await listSessionCatalog({ ...f, sessionDirs: [dir] })).sessions[0]?.control).toBeNull();
	});

	test("read keeps visible user/assistant text, omits tools and thinking, and caps the tail", async () => {
		const f = await fixture();
		const file = await session(path.join(f.root, "isolated"), "transcript", f.cwd, [
			{ role: "user", content: "question", timestamp: 1_780_000_000_000 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hidden" },
					{ type: "toolCall", id: "t", name: "read", arguments: {} },
				],
				timestamp: 1_780_000_001_000,
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "t",
				toolName: "read",
				content: [{ type: "text", text: "secret tool output" }],
				isError: false,
				timestamp: 1_780_000_002_000,
			},
			{
				role: "assistant",
				content: [
					{ type: "text", text: "first" },
					{ type: "thinking", thinking: "hidden" },
					{ type: "text", text: "second" },
					{ type: "toolCall", id: "dangling", name: "read", arguments: {} },
				],
				timestamp: 1_780_000_003_000,
				stopReason: "stop",
			},
		]);
		const before = (await fs.readdir(path.dirname(file))).sort();
		const full = await readSessionCatalog(file);
		if (full.branchMessages === undefined) throw new Error("Native fixture lost its branch identities");
		expect(full.messages).toEqual([
			{ entryId: "m0", role: "user", text: "question", timestamp: new Date(1_780_000_000_000).toISOString() },
			{
				entryId: "m3",
				role: "assistant",
				text: "first\n\nsecond",
				timestamp: new Date(1_780_000_003_000).toISOString(),
			},
		]);
		expect(full.branchMessagesTruncated).toBe(false);
		expect(full.branchEntryIds).toEqual(["m0", "m1", "m2", "m3"]);
		expect(full.leafId).toBe("m3");
		expect(full.truncated).toBe(false);
		const tail = await readSessionCatalog(file, 1);
		expect(tail.messages).toEqual(full.messages.slice(-1));
		expect(tail.truncated).toBe(true);
		expect(tail.branchMessages).toEqual(full.branchMessages.slice(-1));
		expect(tail.branchMessagesTruncated).toBe(true);
		expect((await readSessionCatalog(file, 0)).messages).toEqual([]);
		expect((await fs.readdir(path.dirname(file))).sort()).toEqual(before);
		await expect(readSessionCatalog(file, -1)).rejects.toThrow("nonnegative integer");
	});

	test("read preserves visible messages with missing, malformed, or out-of-range timestamps", async () => {
		const f = await fixture();
		const timestamps = [
			undefined,
			"not-a-date",
			null,
			{},
			true,
			8_640_000_000_000_001,
			0,
			"2026-06-01T00:00:00.000Z",
		];
		const file = await session(
			path.join(f.root, "isolated"),
			"bad-message-dates",
			f.cwd,
			timestamps.map((timestamp, index) => ({
				role: "user",
				content: `message ${index}`,
				timestamp,
			})),
		);
		const before = await Bun.file(file).text();
		const result = await readSessionCatalog(file);
		const expected = timestamps.map((_timestamp, index) => ({
			entryId: `m${index}`,
			role: "user" as const,
			text: `message ${index}`,
			timestamp: index < 6 ? null : index === 6 ? "1970-01-01T00:00:00.000Z" : "2026-06-01T00:00:00.000Z",
		}));
		expect(result.messages).toEqual(expected);
		expect(result.branchMessages).toEqual(expected);
		expect(await Bun.file(file).text()).toBe(before);
	});

	test("pre-tree transcript reads also keep messages with invalid timestamps", async () => {
		const f = await fixture();
		const file = path.join(f.root, "legacy.jsonl");
		await Bun.write(
			file,
			[
				{ type: "session", version: 1, id: "legacy", cwd: f.cwd, timestamp: "2026-06-01T00:00:00.000Z" },
				{ type: "message", message: { role: "user", content: "missing date" } },
				{ type: "message", message: { role: "assistant", content: "bad date", timestamp: "not-a-date" } },
			]
				.map(record => JSON.stringify(record))
				.join("\n") + "\n",
		);
		expect((await readSessionCatalog(file)).messages).toEqual([
			{ role: "user", text: "missing date", timestamp: null },
			{ role: "assistant", text: "bad date", timestamp: null },
		]);
	});

	test("read exports complete selected ancestry and native messages across compaction without writing", async () => {
		const f = await fixture();
		const file = await session(path.join(f.root, "isolated"), "branched", f.cwd, [
			{ role: "user", content: "before compaction", timestamp: 1_780_000_000_000 },
			{
				role: "assistant",
				content: [{ type: "text", text: "original reply" }],
				timestamp: 1_780_000_001_000,
				stopReason: "stop",
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "abandoned branch" }],
				timestamp: 1_780_000_002_000,
				stopReason: "stop",
			},
		]);
		const timestamp = "2026-06-01T00:00:00.000Z";
		const selectedEntries = [
			{ type: "custom", id: "custom", parentId: "m1", timestamp, customType: "checkpoint", data: {} },
			{
				type: "custom_message",
				id: "custom-message",
				parentId: "custom",
				timestamp,
				customType: "notification",
				content: "not a user or assistant turn",
				display: true,
			},
			{
				type: "compaction",
				id: "compaction",
				parentId: "custom-message",
				timestamp,
				summary: "collapsed summary",
				firstKeptEntryId: "",
				tokensBefore: 1000,
			},
			{
				type: "message",
				id: "tool-call",
				parentId: "compaction",
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }],
					timestamp: 1_780_000_003_000,
					stopReason: "toolUse",
				},
			},
			{
				type: "message",
				id: "tool-result",
				parentId: "tool-call",
				timestamp,
				message: {
					role: "toolResult",
					toolCallId: "t",
					toolName: "read",
					content: [{ type: "text", text: "hidden tool result" }],
					isError: false,
					timestamp: 1_780_000_004_000,
				},
			},
			{
				type: "message",
				id: "after",
				parentId: "tool-result",
				timestamp,
				message: { role: "user", content: "after compaction", timestamp: 1_780_000_005_000 },
			},
			{
				type: "message",
				id: "aborted",
				parentId: "after",
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "interrupted reply" }],
					timestamp: 1_780_000_006_000,
					stopReason: "aborted",
				},
			},
			{ type: "custom", id: "leaf", parentId: "aborted", timestamp, customType: "checkpoint", data: {} },
		];
		await Bun.write(
			file,
			(await Bun.file(file).text()) + selectedEntries.map(entry => `${JSON.stringify(entry)}\n`).join(""),
		);
		const source = await Bun.file(file).text();
		const filesBefore = (await fs.readdir(path.dirname(file))).sort();
		const full = await readSessionCatalog(file);
		if (full.branchMessages === undefined) throw new Error("Native fixture lost its branch identities");
		expect(full.branchMessages).toEqual([
			{
				entryId: "m0",
				role: "user",
				text: "before compaction",
				timestamp: new Date(1_780_000_000_000).toISOString(),
			},
			{
				entryId: "m1",
				role: "assistant",
				text: "original reply",
				timestamp: new Date(1_780_000_001_000).toISOString(),
			},
			{
				entryId: "after",
				role: "user",
				text: "after compaction",
				timestamp: new Date(1_780_000_005_000).toISOString(),
			},
			{
				entryId: "aborted",
				role: "assistant",
				text: "interrupted reply",
				timestamp: new Date(1_780_000_006_000).toISOString(),
			},
		]);
		expect(full.messages).toEqual(full.branchMessages.slice(2));
		const branchEntryIds = ["m0", "m1", ...selectedEntries.map(entry => entry.id)];
		expect(full.branchEntryIds).toEqual(branchEntryIds);
		expect(full.leafId).toBe("leaf");
		expect(full.truncated).toBe(false);
		expect(full.branchMessagesTruncated).toBe(false);
		for (const cap of [0, 1, full.messages.length, full.branchMessages.length]) {
			const capped = await readSessionCatalog(file, cap);
			expect(capped.messages).toEqual(full.messages.slice(Math.max(0, full.messages.length - cap)));
			expect(capped.branchMessages).toEqual(
				full.branchMessages.slice(Math.max(0, full.branchMessages.length - cap)),
			);
			expect(capped.branchMessagesTruncated).toBe(cap < full.branchMessages.length);
			expect(capped.branchEntryIds).toEqual(branchEntryIds);
			expect(capped.leafId).toBe("leaf");
			expect(capped.truncated).toBe(cap < full.messages.length);
		}
		expect(await Bun.file(file).text()).toBe(source);
		expect((await fs.readdir(path.dirname(file))).sort()).toEqual(filesBefore);
	});

	test("read exports complete native user and exit boundaries with validated turn completion metadata", async () => {
		const f = await fixture();
		const file = await session(path.join(f.root, "isolated"), "exit-boundaries", f.cwd);
		const timestamp = "2026-06-01T00:00:00.000Z";
		const cleanExit = { kind: "normal", reason: "dispose", recordedAt: timestamp };
		const entries: object[] = [
			{
				type: "custom",
				id: "abandoned-exit",
				parentId: "m0",
				timestamp,
				customType: "session_exit",
				data: cleanExit,
			},
		];
		let parentId = "m0";
		const append = (id: string, data: object) => {
			entries.push({ ...data, id, parentId, timestamp });
			parentId = id;
		};
		const assistant = (id: string, stopReason: string) =>
			append(id, {
				type: "message",
				message: { role: "assistant", content: [], timestamp: 1_780_000_001_000, stopReason },
			});
		const exit = (id: string, data: object) => append(id, { type: "custom", customType: "session_exit", data });
		assistant("reply", "stop");
		exit("clean-exit", cleanExit);
		append("textless-user", {
			type: "message",
			message: { role: "user", content: [], timestamp: 1_780_000_002_000 },
		});
		exit("unanswered-exit", cleanExit);
		assistant("tool-reply", "toolUse");
		exit("pending-exit", { ...cleanExit, pendingToolCalls: [{ toolName: "read", toolCallId: "t" }] });
		assistant("length-reply", "length");
		exit("length-exit", { ...cleanExit, pendingToolCalls: [] });
		exit("fatal-exit", { ...cleanExit, kind: "fatal", reason: "uncaughtException" });
		exit("invalid-pending-exit", { ...cleanExit, pendingToolCalls: [{}] });
		exit("invalid-null-pending-exit", { ...cleanExit, pendingToolCalls: null });
		exit("invalid-kind-exit", { ...cleanExit, kind: "unknown" });
		exit("missing-time-exit", { kind: "normal", reason: "dispose" });
		exit("missing-reason-exit", { kind: "normal", recordedAt: timestamp });
		append("non-object-exit", { type: "custom", customType: "session_exit", data: null });
		append("not-an-exit", { type: "custom", customType: "other", data: cleanExit });
		append("wrong-entry-type", {
			type: "custom_message",
			customType: "session_exit",
			content: "not a native exit marker",
			display: true,
			data: cleanExit,
		});
		append("blank-user", {
			type: "message",
			message: { role: "user", content: " \n ", timestamp: 1_780_000_003_000 },
		});
		exit("blank-user-exit", cleanExit);
		await Bun.write(
			file,
			(await Bun.file(file).text()) + entries.map(entry => `${JSON.stringify(entry)}\n`).join(""),
		);
		const expectedExits: SessionCatalogExit[] = [
			{
				entryId: "clean-exit",
				kind: "normal",
				reason: "dispose",
				pendingToolCallCount: 0,
				lastAssistantStopReason: "stop",
			},
			{
				entryId: "unanswered-exit",
				kind: "normal",
				reason: "dispose",
				pendingToolCallCount: 0,
				lastAssistantStopReason: null,
			},
			{
				entryId: "pending-exit",
				kind: "normal",
				reason: "dispose",
				pendingToolCallCount: 1,
				lastAssistantStopReason: "toolUse",
			},
			{
				entryId: "length-exit",
				kind: "normal",
				reason: "dispose",
				pendingToolCallCount: 0,
				lastAssistantStopReason: "length",
			},
			{
				entryId: "fatal-exit",
				kind: "fatal",
				reason: "uncaughtException",
				pendingToolCallCount: 0,
				lastAssistantStopReason: "length",
			},
			{
				entryId: "blank-user-exit",
				kind: "normal",
				reason: "dispose",
				pendingToolCallCount: 0,
				lastAssistantStopReason: null,
			},
		];
		const expectedExitIds = [
			"clean-exit",
			"unanswered-exit",
			"pending-exit",
			"length-exit",
			"fatal-exit",
			"invalid-pending-exit",
			"invalid-null-pending-exit",
			"invalid-kind-exit",
			"missing-time-exit",
			"missing-reason-exit",
			"non-object-exit",
			"blank-user-exit",
		];
		for (const cap of [undefined, 0, 1]) {
			const catalog = await readSessionCatalog(file, cap);
			expect(catalog.userEntryIds).toEqual(["m0", "textless-user", "blank-user"]);
			expect(catalog.sessionExits).toEqual(expectedExits);
			expect(catalog.sessionExitEntryIds).toEqual(expectedExitIds);
			expect(catalog.leafId).toBe("blank-user-exit");
		}
	});

	test("read reports an empty branch with a null leaf, even with a zero message cap", async () => {
		const f = await fixture();
		const file = await session(path.join(f.root, "isolated"), "empty", f.cwd, []);
		expect(await readSessionCatalog(file, 0)).toMatchObject({
			version: 1,
			messages: [],
			branchMessages: [],
			branchMessagesTruncated: false,
			branchEntryIds: [],
			leafId: null,
			userEntryIds: [],
			sessionExits: [],
			sessionExitEntryIds: [],
			truncated: false,
		});
	});

	test("read preserves pre-tree journals without exposing invented native identities or writing files", async () => {
		const f = await fixture();
		const dir = path.join(f.root, "legacy");
		for (const version of [undefined, 1]) {
			const file = path.join(dir, `legacy-${version ?? "unversioned"}.jsonl`);
			const records = [
				{ type: "session", version, id: "legacy", cwd: f.cwd, timestamp: "2026-06-01T00:00:00.000Z" },
				{
					type: "message",
					timestamp: "2026-06-01T00:00:00.000Z",
					message: { role: "user", content: "legacy question", timestamp: 1_780_000_000_000 },
				},
			];
			const source = `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
			await Bun.write(file, source);
			const filesBefore = (await fs.readdir(dir)).sort();
			const messages: SessionCatalogMessage[] = [
				{ role: "user", text: "legacy question", timestamp: new Date(1_780_000_000_000).toISOString() },
			];
			expect(await readSessionCatalog(file)).toEqual({
				version: 1,
				session: { path: file, id: "legacy", cwd: f.cwd, title: null },
				messages,
				truncated: false,
			});
			expect(await readSessionCatalog(file, 0)).toEqual({
				version: 1,
				session: { path: file, id: "legacy", cwd: f.cwd, title: null },
				messages: [],
				truncated: true,
			});
			expect(await loadSessionMessagesReadOnly(file)).toMatchObject([
				{ role: "user", content: "legacy question", timestamp: 1_780_000_000_000 },
			]);
			expect(await Bun.file(file).text()).toBe(source);
			expect((await fs.readdir(dir)).sort()).toEqual(filesBefore);
		}
	});

	test("identity export keeps persisted v2 IDs stable across read-only role migration", async () => {
		const f = await fixture();
		const file = path.join(f.root, "v2", "native.jsonl");
		const records = [
			{ type: "session", version: 2, id: "native-v2", cwd: f.cwd, timestamp: "2026-06-01T00:00:00.000Z" },
			{
				type: "message",
				id: "native-user",
				parentId: null,
				timestamp: "2026-06-01T00:00:00.000Z",
				message: { role: "user", content: "native question", timestamp: 1_780_000_000_000 },
			},
			{
				type: "message",
				id: "native-hook",
				parentId: "native-user",
				timestamp: "2026-06-01T00:00:00.000Z",
				message: { role: "hookMessage", content: "extension metadata", timestamp: 1_780_000_001_000 },
			},
		];
		const source = `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
		await Bun.write(file, source);
		const full = await readSessionCatalog(file);
		expect(full.messages).toEqual([
			{
				entryId: "native-user",
				role: "user",
				text: "native question",
				timestamp: new Date(1_780_000_000_000).toISOString(),
			},
		]);
		expect(full.branchEntryIds).toEqual(["native-user", "native-hook"]);
		expect(full.leafId).toBe("native-hook");
		expect(await readSessionCatalog(file)).toEqual(full);
		expect(await Bun.file(file).text()).toBe(source);
	});

	test("CLI emits JSON documents and machine-readable errors with an isolated control registry", async () => {
		const f = await fixture();
		const dir = path.join(f.root, "isolated");
		const file = await session(dir, "cli", f.cwd);
		const env = {
			...process.env,
			PI_CODING_AGENT_DIR: f.agentDir,
			PI_CONTROL_DIR: f.controlRegistry.dir,
			OMP_PROFILE: "",
			PI_PROFILE: "",
		};
		const run = async (args: string[]) => {
			const child = Bun.spawn(
				[process.execPath, path.resolve(import.meta.dir, "../src/cli.ts"), "sessions", ...args],
				{ env, stdout: "pipe", stderr: "pipe" },
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { stdout, stderr, code };
		};
		const listed = await run(["list", "--json", "--session-dir", dir]);
		expect(listed.code).toBe(0);
		expect(JSON.parse(listed.stdout).sessions[0]).toMatchObject({
			id: "cli",
			path: file,
			inUse: null,
			control: null,
		});
		const read = await run(["read", "--json", file, "--max-messages", "0"]);
		expect(read.code).toBe(0);
		expect(JSON.parse(read.stdout)).toMatchObject({
			version: 1,
			messages: [],
			branchMessages: [],
			branchMessagesTruncated: true,
			branchEntryIds: ["m0"],
			leafId: "m0",
			userEntryIds: ["m0"],
			sessionExits: [],
			sessionExitEntryIds: [],
			truncated: true,
		});
		const missing = await run(["read", "--json", path.join(dir, "missing.jsonl")]);
		expect(missing.code).toBe(1);
		expect(missing.stdout).toBe("");
		expect(JSON.parse(missing.stderr)).toMatchObject({ type: "error", code: "session_catalog_error" });
	});
});

describe("session catalog liveness (--live)", () => {
	async function publish(f: Awaited<ReturnType<typeof fixture>>, instanceId: string, file: string, cwd: string) {
		return publishControlEndpoint({
			dir: f.controlRegistry.dir,
			role: "tui",
			instanceId,
			imageId: "test",
			execPath: process.execPath,
			gitSha: null,
			profile: null,
			sessionId: instanceId,
			sessionFile: file,
			title: null,
			cwd,
			tmuxPane: null,
			tmuxSession: null,
			tmuxWindow: null,
			tty: null,
			onConnection: socket => socket.destroy(),
		});
	}

	function snapshotFor(cwd: string, state: "busy" | "waiting" | "idle"): ControlSnapshot {
		return {
			cwd,
			dialogs: state === "waiting" ? [{ dialogId: "d1" }] : [],
			busy: {
				streaming: state === "busy",
				compacting: false,
				pendingSteerAndFollowUp: 0,
				pendingAsyncWork: false,
				settled: state !== "busy",
			},
		} as unknown as ControlSnapshot;
	}

	test("reports busy, waiting and idle sessions with their branch, null when unreachable or not live, and leaves default output alone", async () => {
		const f = await fixture();
		const repo = path.join(f.root, "repo");
		await fs.mkdir(repo);
		for (const args of [
			["init", "-q", "-b", "feat/live"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"],
		]) {
			expect(await Bun.spawn(["git", ...args], { cwd: repo }).exited).toBe(0);
		}
		const dir = sessionDirForCwd(f.cwd, f.sessionsRoot);
		const files = {
			busy: await session(dir, "busy", repo),
			waiting: await session(dir, "waiting", f.cwd),
			idle: await session(dir, "idle", f.cwd),
			dead: await session(dir, "dead", f.cwd),
			silent: await session(dir, "silent", f.cwd),
			none: await session(dir, "none", f.cwd),
		};
		const cwds: Record<string, string> = { busy: repo, waiting: f.cwd, idle: f.cwd, dead: f.cwd, silent: f.cwd };
		const publications = await Promise.all(
			Object.entries(cwds).map(([name, cwd]) =>
				publish(f, `${name}000000000`, files[name as keyof typeof files], cwd),
			),
		);
		try {
			const probeControl = async (metadata: { instanceId: string }) => {
				const name = metadata.instanceId.replace("000000000", "");
				if (name === "dead") throw new Error("unreachable");
				if (name === "silent") return new Promise<ControlSnapshot>(() => {});
				return snapshotFor(cwds[name], name as "busy" | "waiting" | "idle");
			};
			const withLive = (
				await listSessionCatalog({ ...f, sessionDirs: [dir], live: true, liveTimeoutMs: 100, probeControl })
			).sessions;
			const byId = Object.fromEntries(withLive.map(row => [row.id, row.live]));
			expect(byId.busy).toEqual({ state: "busy", isStreaming: true, pendingDialogs: 0, branch: "feat/live" });
			expect(byId.waiting).toEqual({ state: "waiting", isStreaming: false, pendingDialogs: 1, branch: null });
			expect(byId.idle).toEqual({ state: "idle", isStreaming: false, pendingDialogs: 0, branch: null });
			expect(byId.dead).toBeNull();
			expect(byId.silent).toBeNull();
			expect(byId.none).toBeNull();
			const plain = (await listSessionCatalog({ ...f, sessionDirs: [dir] })).sessions;
			for (const row of plain) expect("live" in row).toBe(false);
		} finally {
			await Promise.all(publications.map(publication => publication.close()));
		}
	});
});

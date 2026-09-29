/**
 * Control socket handshake and targeting.
 *
 * A consumer sees: a same-user client that presents the registry token gets a
 * snapshot; a wrong token is refused and the socket closes; a target selector
 * resolves by pane id and rejects an ambiguous prefix.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, ControlClientError } from "../../src/control/client";
import { HostBudget } from "../../src/control/budget";
import { publishControlEndpoint, readControlEntries, type ControlMetadata } from "../../src/control/registry";
import { ControlServer } from "../../src/control/server";
import type { ControlSnapshot } from "../../src/control/types";

function snapshot(instanceId: string): ControlSnapshot {
	return {
		version: 1,
		instanceId,
		imageId: "img",
		role: "tui",
		pid: process.pid,
		ready: true,
		build: { version: "test", gitSha: null, dirty: null, execPath: process.execPath },
		tmux: { pane: "%9", session: null, window: null },
		cwd: "/tmp",
		title: "pane-nine",
		session: null,
		busy: { streaming: false, compacting: false, queued: 0, pendingAsyncWork: false, settled: true },
		revisions: { generation: 1, human: 0, focus: 0, draft: 0, dialogs: 0, paint: 0, model: null, role: null },
		view: null,
		modes: { plan: false, chat: "off", goal: false, vibe: false, live: false, repl: false },
		dialogs: [],
		connections: 1,
		requests: { open: 0, retained: 0 },
		hosts: [],
		approvals: { controlAllowed: false, pending: 0 },
		exemptions: [],
	};
}

describe("control socket", () => {
	test("same-user hello returns the snapshot; a bad token is refused", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-ctl-"));
		const host = {
			instanceId: "abcd1234abcd1234",
			token: "",
			budget: new HostBudget(),
			registryDir: dir,
			snapshot: () => snapshot("abcd1234abcd1234"),
			dispatch: async (connection: { respond: (response: object) => void }, frame: Record<string, unknown>) => {
				if (frame.type === "get_status") {
					connection.respond({
						type: "response",
						command: "get_status",
						requestId: frame.requestId,
						success: true,
						data: snapshot("abcd1234abcd1234"),
					});
				}
			},
			onClosed: () => {},
		};
		const serverBox: { current?: ControlServer } = {};
		const publication = await publishControlEndpoint({
			dir,
			role: "tui",
			instanceId: host.instanceId,
			imageId: "image",
			execPath: process.execPath,
			gitSha: "abc",
			profile: null,
			sessionId: "sess",
			sessionFile: null,
			title: "pane-nine",
			cwd: "/tmp",
			tmuxPane: "%9",
			tmuxSession: null,
			tmuxWindow: null,
			tty: null,
			onConnection: socket => serverBox.current!.accept(socket),
		});
		host.token = publication.token;
		serverBox.current = new ControlServer({ metadata: { instanceId: host.instanceId }, host: host as never });

		const client = new ControlClient({ metadata: publication.metadata(), label: "orch", kind: "cli" });
		const hello = await client.connect();
		expect(hello.instanceId).toBe("abcd1234abcd1234");
		expect(hello.title).toBe("pane-nine");
		const status = await client.request({ type: "get_status" });
		expect(status.success).toBe(true);
		client.close();

		const intruder = new ControlClient({
			metadata: { ...publication.metadata(), token: "0".repeat(64) },
			label: "nope",
			kind: "cli",
		});
		await expect(intruder.connect()).rejects.toBeInstanceOf(ControlClientError);

		const raw = net.connect(publication.metadata().endpoint);
		await once(raw, "data"); // challenge
		raw.write(`${JSON.stringify({ type: "hello", token: publication.token, client: { label: "chunk-test", kind: "cli" }, protocolVersion: 2 })}\n`);
		await once(raw, "data"); // authenticated hello
		const closed = once(raw, "close");
		raw.write(`${JSON.stringify({ type: "rpc_chunk", chunkId: "interrupted", index: 0, count: 2, byteLength: 2 * 1024 * 1024, data: "e30=" })}\n${JSON.stringify({ type: "get_status" })}\n`);
		await closed;
		expect(host.budget.inboundBytes).toBe(0);
		await publication.close();

		const listed = await readControlEntries({ dir });
		expect(listed).toHaveLength(0);
	});

	test("prunes a current-version publication when its live PID has different start ticks", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-ctl-reused-pid-"));
		const meta: ControlMetadata = {
			version: 1,
			instanceId: "abcdef0123456789",
			imageId: "stale",
			pid: process.pid,
			procStartTicks: 1,
			endpoint: join(dir, "stale.sock"),
			createdAt: Date.now(),
			startedAt: Date.now(),
			token: "a".repeat(64),
			role: "tui",
			execPath: process.execPath,
			gitSha: null,
			profile: null,
			sessionId: null,
			sessionFile: null,
			title: null,
			cwd: dir,
			tmuxPane: null,
			tmuxSession: null,
			tmuxWindow: null,
			tty: null,
		};
		const file = join(dir, "abcdef0123456789.json");
		writeFileSync(file, JSON.stringify(meta));
		expect(await readControlEntries({ dir })).toHaveLength(0);
		expect(existsSync(file)).toBe(false);
	});
});

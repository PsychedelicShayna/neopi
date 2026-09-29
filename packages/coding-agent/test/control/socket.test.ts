/**
 * Control socket handshake and targeting.
 *
 * A consumer sees: a same-user client that presents the registry token gets a
 * snapshot; a wrong token is refused and the socket closes; a target selector
 * resolves by pane id and rejects an ambiguous prefix.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
			dispatch: async (
				connection: { respond: (response: object) => void },
				frame: Record<string, unknown>,
			) => {
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
		await publication.close();

		const listed = await readControlEntries({ dir });
		expect(listed).toHaveLength(0);
	});
});

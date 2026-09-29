/**
 * Control host behavior over a real socket, against a real session on a mock
 * model (no network). A consumer sees: approval ownership stays with the pane,
 * a session replaced outside RPC bumps generation and republishes the
 * registry, large commands are accepted, `serve` answers once and leaves no
 * half-installed service, and every declared control-only command routes.
 */
import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { ctlList, ctlState, withCtlCaller, withCtlIo } from "../../src/cli/ctl-cli";
import { ControlClient } from "../../src/control/client";
import type { ControlPresenter } from "../../src/control/presenter";
import { ControlHost } from "../../src/control/host";
import { type ControlMetadata, readControlEntries } from "../../src/control/registry";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import { AgentSession } from "../../src/session/agent-session";
import type { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

describe("control host", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let host: ControlHost | undefined;
	let client: ControlClient | undefined;
	let dir: string;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-control-host-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(async () => {
		client?.close();
		client = undefined;
		await host?.close();
		host = undefined;
		await session?.dispose();
		session = undefined;
	});

	afterAll(async () => {
		authStorage.close();
		await tempDir.remove();
	});

	async function start(settings: Record<string, unknown> = {}): Promise<{ host: ControlHost; client: ControlClient }> {
		const model = createMockModel({ provider: "anthropic", responses: [] });
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: [], tools: [] },
				streamFn: model.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, ...settings }),
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
		});
		dir = mkdtempSync(join(tmpdir(), "omp-ctl-host-"));
		host = new ControlHost({ session, role: "rpc", dir, tmuxPane: null });
		await host.start();
		const publication = host.publication;
		if (!publication) throw new Error("control host did not publish");
		client = new ControlClient({ metadata: publication.metadata(), label: "test", kind: "cli" });
		await client.connect();
		return { host, client };
	}

	test("set_approval_handler and tool_approval_response stay with the pane while control.approvals is off", async () => {
		const { client } = await start();
		const handler = await client.request({ type: "set_approval_handler", handler: "host" });
		expect(handler.success).toBe(false);
		expect(handler.code).toBe("approval_owner_only");
		const verdict = await client.request({ type: "tool_approval_response", id: "t1", approved: true });
		expect(verdict.success).toBe(false);
		expect(verdict.code).toBe("approval_owner_only");
	});

	test("credential settings are unreadable over control while control.secretInput is off", async () => {
		const { client } = await start({ "auth.broker.token": "hunter2" });
		const reply = await client.request({ type: "settings_get", path: "auth.broker.token" });
		expect(reply.success).toBe(false);
		expect(reply.code).toBe("secret_input_disabled");
		expect(JSON.stringify(reply)).not.toContain("hunter2");
	});

	test("a session replaced outside RPC bumps generation and republishes its registry entry", async () => {
		const { host } = await start();
		const before = session!.sessionId;
		expect(host.revisions.generation).toBe(1);
		await session!.newSession();
		// The first ordinary session event after the transition observes it.
		session!.emitNotice("info", "after transition");
		expect(session!.sessionId).not.toBe(before);
		expect(host.revisions.generation).toBe(2);
		const [entry] = await readControlEntries({ dir });
		expect(entry?.meta.sessionId).toBe(session!.sessionId);
	});

	test("a command larger than one physical frame is chunked and accepted, not rate limited", async () => {
		const { client } = await start();
		const pad = "x".repeat(6 * 1024 * 1024);
		const status = await client.request({ type: "get_status", pad });
		expect(status.success).toBe(true);
	});

	test("serve answers once, and a bad scheme leaves no host tool installed", async () => {
		const { client } = await start();
		const responses: Record<string, unknown>[] = [];
		client.onEvent(frame => {
			if (frame.type === "response") responses.push(frame);
		});
		const served = await client.request({
			type: "serve",
			tools: [{ name: "ctl_echo", description: "echo", parameters: { type: "object", properties: {} } }],
			schemes: [{ scheme: "not a scheme" }],
		});
		await Bun.sleep(50);
		expect(served.success).toBe(false);
		expect(responses).toHaveLength(0);
		expect(session!.hasRpcHostTool("ctl_echo")).toBe(false);
	});

	test("unserve removes the URI schemes the service installed", async () => {
		const { client } = await start();
		const served = await client.request({ type: "serve", schemes: [{ scheme: "ctltest" }] });
		expect(served.success).toBe(true);
		expect(InternalUrlRouter.instance().getHandler("ctltest")).toBeDefined();
		const removed = await client.request({
			type: "unserve",
			serviceId: (served.data as { serviceId: string }).serviceId,
		});
		expect(removed.success).toBe(true);
		expect(InternalUrlRouter.instance().getHandler("ctltest")).toBeUndefined();
	});

	test("every declared control-only command routes to an implementation", async () => {
		const { client } = await start();
		const replies = await Promise.all([
			client.request({ type: "switch_model", selector: "no-such-model-anywhere" }),
			client.request({ type: "dequeue" }),
			client.request({ type: "requests" }),
			client.request({ type: "rewind", entryId: "missing-entry" }),
			client.request({ type: "draft_insert", text: "x", if: { draft: 0 } }),
		]);
		for (const reply of replies) expect(reply.error ?? "").not.toContain("Unknown command");
		expect(replies.map(reply => reply.code)).toEqual([
			"unknown_model",
			"empty_queue",
			undefined,
			"rewind_invalid",
			"no_tui",
		]);
		expect(replies[2]?.data).toEqual({ open: [], settled: [] });
	});

	/** A presenter that records what reached the pane; `approvalOpen` mimics the approval selector. */
	function stubPresenter(state: { approvalOpen: boolean }) {
		const seen = {
			injected: [] as string[],
			submitted: [] as { text: string; images?: ImageContent[] }[],
			drafts: [] as { text: string; images?: ImageContent[] }[],
		};
		const presenter: ControlPresenter = {
			submit: async (text, images) => {
				seen.submitted.push({ text, images });
				return { delivery: "started" };
			},
			action: async () => ({ handled: true }),
			inject: bytes => seen.injected.push(bytes),
			esc: async () => ({ handled: true }),
			screen: () => ({ lines: [] }),
			dialogs: () =>
				state.approvalOpen
					? [{ dialogId: "d1", family: "approval", kind: "approval", title: "Approve bash?" } as never]
					: [],
			answerDialog: async () => ({ settled: false }),
			draft: () => ({ text: "", images: [] }),
			setDraft: (text, images) => seen.drafts.push({ text, images }),
			insertDraft: () => {},
			rewind: async () => ({ status: "rewound" }),
			notify: () => {},
			draftRevision: () => 0,
			focusRevision: () => 0,
			dialogRevision: () => 0,
		};
		return { presenter, seen };
	}

	test("keys, paste, mouse, and actions cannot answer an open approval while control.approvals is off", async () => {
		const { host, client } = await start();
		const state = { approvalOpen: true };
		const { presenter, seen } = stubPresenter(state);
		host.presenter = presenter;
		const replies = await Promise.all([
			client.request({ type: "keys", keys: [{ key: "enter" }] }),
			client.request({ type: "paste", text: "y" }),
			client.request({ type: "mouse", x: 1, y: 1 }),
			client.request({ type: "action", actionId: "tui.select.confirm" }),
		]);
		expect(replies.map(reply => reply.code)).toEqual([
			"approval_owner_only",
			"approval_owner_only",
			"approval_owner_only",
			"approval_owner_only",
		]);
		expect(seen.injected).toEqual([]);
		state.approvalOpen = false;
		const keys = await client.request({ type: "keys", keys: [{ key: "enter" }] });
		expect(keys.success).toBe(true);
		expect(seen.injected).toHaveLength(1);
	});

	test("a ctl tool call stays bound to its caller while an overlapping call finishes", async () => {
		const { host } = await start();
		const previous = process.env.PI_CONTROL_DIR;
		process.env.PI_CONTROL_DIR = dir;
		try {
			const quick = withCtlCaller(async () => {});
			const slow = withCtlCaller(async () => {
				await Bun.sleep(20);
				return withCtlIo({ stdout: () => {}, stderr: () => {} }, () => ctlState(host.instanceId, true));
			});
			await quick;
			// Bound to this host's own publication, the target is itself: self-target is refused.
			await expect(slow).rejects.toMatchObject({ code: "self_target" });
		} finally {
			if (previous === undefined) delete process.env.PI_CONTROL_DIR;
			else process.env.PI_CONTROL_DIR = previous;
		}
	});

	test("draft writes need a numeric if.draft, and draft_set and input keep their images", async () => {
		const { host, client } = await start();
		const { presenter, seen } = stubPresenter({ approvalOpen: false });
		host.presenter = presenter;
		const image: ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };
		const unguarded = await client.request({ type: "draft_set", text: "overwrite", if: {} });
		expect(unguarded.code).toBe("precondition_required");
		expect(seen.drafts).toEqual([]);
		const guarded = await client.request({ type: "draft_set", text: "restored", images: [image], if: { draft: 0 } });
		expect(guarded.success).toBe(true);
		expect(seen.drafts).toEqual([{ text: "restored", images: [image] }]);
		await client.request({ type: "input", text: "look", images: [image] });
		expect(seen.submitted).toEqual([{ text: "look", images: [image] }]);
	});
});

describe("control client handshake", () => {
	test("a server that never challenges times out and the client closes its socket", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-ctl-silent-"));
		const endpoint = join(dir, "silent.sock");
		const closed = Promise.withResolvers<void>();
		const server = net.createServer(socket => socket.once("close", () => closed.resolve()));
		await new Promise<void>(resolve => server.listen(endpoint, resolve));
		try {
			const client = new ControlClient({
				metadata: { instanceId: "silentsilent", endpoint, token: "t" } as ControlMetadata,
				label: "test",
				kind: "cli",
				timeoutMs: 100,
			});
			await expect(client.connect()).rejects.toMatchObject({ code: "timeout" });
			await closed.promise;
		} finally {
			server.close();
		}
	});
});

describe("ctl tool request scope", () => {
	test("overlapping ctl calls keep their own output sink", async () => {
		const previous = process.env.PI_CONTROL_DIR;
		process.env.PI_CONTROL_DIR = mkdtempSync(join(tmpdir(), "omp-ctl-io-"));
		try {
			let a = "";
			let b = "";
			const first = withCtlIo({ stdout: text => (a += text), stderr: () => {} }, async () => {});
			const second = withCtlIo({ stdout: text => (b += text), stderr: () => {} }, async () => {
				await Bun.sleep(20);
				await ctlList(true);
			});
			await Promise.all([first, second]);
			expect(a).toBe("");
			expect(JSON.parse(b)).toEqual({ version: 1, sessions: [] });
		} finally {
			if (previous === undefined) delete process.env.PI_CONTROL_DIR;
			else process.env.PI_CONTROL_DIR = previous;
		}
	});
});
